/**
 * Enforcement of the `pluginInstall` managed-policy area (docs/adr/0052,
 * docs/design/enterprise-controls.md section 2).
 *
 * `decidePluginInstall` is pure: effective policy + action (+ the resolved
 * GitHub owner/repo) in, allow/refuse out. `guardPluginInstall` is the thin IO
 * wrapper the main-process IPC handlers call; it reads the effective policy
 * fresh on every call (no cache, no watcher, ADR 0002) for the calling
 * window's vault and throws a clear error on refusal.
 *
 * Honest limits: this guards Geode's own install entry points in the main
 * process. The renderer runs with `nodeIntegration: true`, so code that already
 * executes there (a plugin, a hostile vault script) can write files into
 * `.geode/plugins/` directly, and users can run any binary they like. The
 * control stops the supported install paths from fetching or writing plugin
 * code; it is not a sandbox. The `plugins` allowlist (enforced on enable)
 * remains the control for code that is already on disk.
 */

import type { EffectivePolicy } from "../renderer/policy-layering";
import { loadEffectivePolicy } from "./policy-loader";
import { parseRepoSpec } from "./github-resolve";

/** The six main-process IPC channels that fetch or write plugin code. */
export type PluginInstallAction =
  | "community-install"
  | "community-resolve"
  | "supported-plugin-catalog"
  | "supported-plugin-install"
  | "community-import-obsidian"
  | "plugin-files-replace";

export const PLUGIN_INSTALL_ACTIONS: readonly PluginInstallAction[] = [
  "community-install",
  "community-resolve",
  "supported-plugin-catalog",
  "supported-plugin-install",
  "community-import-obsidian",
  "plugin-files-replace",
];

/** The only actions that work in `catalog-only` mode: they go through Geode's curated catalog. */
const CATALOG_ACTIONS: ReadonlySet<PluginInstallAction> = new Set<PluginInstallAction>([
  "supported-plugin-catalog",
  "supported-plugin-install",
]);

/**
 * Actions that carry a GitHub owner/repo, which `sources` is matched against.
 * `supported-plugin-install` is included on purpose: if an administrator lists
 * sources, the conservative reading is that nothing outside them is installed,
 * catalog or not. (An administrator who wants the catalog plus their own org
 * lists the catalog repositories as well.)
 */
const REPO_ACTIONS: ReadonlySet<PluginInstallAction> = new Set<PluginInstallAction>([
  "community-install",
  "community-resolve",
  "supported-plugin-install",
]);

export interface RepoRef {
  owner: string;
  repo: string;
}

export type PluginInstallDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Does one `pluginInstall.sources` pattern match this repository?
 *
 * The stage-1 validator (policy.ts `sourceOf`) accepts `/`-separated segments
 * of `[A-Za-z0-9._-]+`, where a single `*` is allowed only as the whole LAST
 * segment (never a prefix/suffix such as `acme-*`, never first). On top of
 * that, the conservative matching rules are:
 *
 *  - Only GitHub is a supported install source, so an optional leading
 *    `github.com` segment (case-insensitive) is the only host recognised. A
 *    different leading host (`gitlab.com/x/y`) never matches.
 *  - `owner/repo`: exact match, case-insensitive (GitHub names are
 *    case-insensitive). Without a leading host the pattern is read as GitHub.
 *  - `owner/*`: any repository of exactly that owner. `*` matches one segment,
 *    the repo; it is not recursive and matches nothing else.
 *  - `github.com/*`: every GitHub repository (explicit administrator intent).
 *    A bare `*` cannot occur: the validator rejects a leading `*`.
 *  - Any other shape (extra path segments such as `owner/repo/sub`) never
 *    matches. Unmatchable is the safe side.
 *  - The fail-closed sentinel the validator emits for an all-invalid list
 *    (`!none`) matches nothing.
 */
export function matchesInstallSource(pattern: string, ref: RepoRef): boolean {
  if (pattern.toLowerCase() === "github.com/*") return true;
  const segments = pattern.split("/");
  if (segments[0]?.toLowerCase() === "github.com") segments.shift();
  const [owner, repo, ...extra] = segments;
  if (owner === undefined || repo === undefined || extra.length > 0) return false;
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq(owner, ref.owner)) return false;
  return repo === "*" || eq(repo, ref.repo);
}

/**
 * Every layer's `sources` list must admit the repository (the vault can only
 * narrow). A list that is present but empty admits nothing, like an empty
 * `plugins` allowlist.
 */
export function repoPassesSources(sourceLists: string[][] | undefined, ref: RepoRef): boolean {
  if (!sourceLists) return true;
  return sourceLists.every((list) => list.some((pattern) => matchesInstallSource(pattern, ref)));
}

/**
 * Decide whether `action` may proceed under `policy`. A `null`/missing policy
 * allows everything (fail open, ADR 0002). `repo` is needed for actions that
 * carry one when `sources` is set; if it cannot be established the call is
 * refused rather than guessed.
 *
 * `plugin-files-replace` (the rollback path that restores a plugin's previous
 * files after a failed reload) writes caller-supplied code into an existing
 * plugin folder, so it is refused under `disabled` and `catalog-only`. It has
 * no source repository, so `sources` cannot be applied to it.
 */
export function decidePluginInstall(
  policy: Pick<EffectivePolicy, "pluginInstall"> | null | undefined,
  action: PluginInstallAction,
  repo?: RepoRef | null,
): PluginInstallDecision {
  const install = policy?.pluginInstall;
  if (!install) return { allowed: true };

  if (install.mode === "disabled") {
    return { allowed: false, reason: `plugin installation is disabled (mode: disabled), so "${action}" is refused` };
  }
  if (install.mode === "catalog-only" && !CATALOG_ACTIONS.has(action)) {
    return {
      allowed: false,
      reason: `only the supported-plugin catalog may install plugins (mode: catalog-only), so "${action}" is refused`,
    };
  }
  if (install.sources && REPO_ACTIONS.has(action)) {
    if (!repo) {
      return {
        allowed: false,
        reason: `the source repository could not be determined, so "${action}" cannot be checked against pluginInstall.sources`,
      };
    }
    if (!repoPassesSources(install.sources, repo)) {
      return { allowed: false, reason: `${repo.owner}/${repo.repo} is not in the allowed pluginInstall.sources` };
    }
  }
  return { allowed: true };
}

/** The clear, policy-naming error every refusal uses. */
export class PluginInstallBlockedError extends Error {
  constructor(public readonly action: PluginInstallAction, reason: string) {
    super(`Plugin install blocked by administrator policy: pluginInstall (${reason}).`);
    this.name = "PluginInstallBlockedError";
  }
}

/**
 * Resolve a user-supplied install spec to owner/repo BEFORE any network I/O.
 * Returns null for an unparseable spec; the decision then refuses if `sources`
 * is set, and otherwise the install proceeds and fails with its own message.
 */
export function repoFromSpec(spec: unknown): RepoRef | null {
  if (typeof spec !== "string") return null;
  try {
    return parseRepoSpec(spec);
  } catch {
    return null;
  }
}

/**
 * Throws `PluginInstallBlockedError` when the effective policy for the vault
 * at `root` (null: no vault open, machine layer only) refuses `action`.
 * `repo` is a spec string (from the renderer) or an already-parsed ref
 * (from the catalog). Call this first in the IPC handler, before any fetch.
 */
export function guardPluginInstall(
  root: string | null,
  action: PluginInstallAction,
  repo?: string | RepoRef | null,
): void {
  const { effective } = loadEffectivePolicy(root);
  const ref = typeof repo === "object" && repo !== null ? repo : repoFromSpec(repo);
  const decision = decidePluginInstall(effective, action, ref);
  if (!decision.allowed) {
    console.warn(`Managed policy: refused "${action}": ${decision.reason}`);
    throw new PluginInstallBlockedError(action, decision.reason);
  }
}
