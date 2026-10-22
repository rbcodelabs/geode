/**
 * Enterprise-managed policy: schema and validators. An IT admin drops a JSON
 * file at a fixed, admin/root-owned OS path (see `policyFilePath()` in
 * `src/main/policy-loader.ts`); a vault may carry a narrowing-only
 * `.geode/policy.json` too. Geode reads them and enforces the result. See
 * `docs/adr/0002-enterprise-plugin-policy.md` and
 * `docs/adr/0051-policy-layering.md` for the full design, and
 * `./policy-layering.ts` for how the two layers combine.
 *
 * This module is deliberately pure (no IO, no Electron/DOM imports) so it
 * can be unit-tested directly and shared, unmodified, between the main
 * process (which reads the files off disk) and the renderer (which enforces
 * it in `PluginManager`). `bundle: true` in `esbuild.config.mjs` builds
 * `main.ts` and `app.ts` as two independent bundles from their own module
 * graphs, so importing this file from `src/main/*` does not pull any
 * renderer/DOM code into the main-process build — only what this file
 * itself imports, which is nothing.
 *
 * Validation rules (docs/design/enterprise-controls.md, "Cross-cutting
 * behavior"):
 *  - One validator per control area. Each area fails open independently: a
 *    malformed area is ignored (logged) and the other areas still apply.
 *  - Inside an area, an optional field with a bad value is dropped on its own;
 *    a bad value for the field that *defines* the area (`mode`) drops the area.
 *  - Unknown keys are ignored, so an older Geode reading a newer file is safe.
 *  - Exception, fail CLOSED: `github.allowedOwners` / `allowedRepos` /
 *    `allowedLogins`, when present and non-empty but with no valid entry. A
 *    broken allowlist must restrict, never open up.
 */

/** Plugin manifest `id` values, per `plugin-manifest.ts`'s `ID_RE`. */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Harness and sync-provider ids (`claude`, `codex`, `hub`, `icloud`, ...). */
const TOKEN_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/** Mirrors `src/main/github-auth/config.ts` so the two parsers cannot disagree. */
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{4,64}$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[\w.-]{1,100}$/;
/** Exact login, or a single leading `*` followed by a suffix (Enterprise Managed Users). */
const LOGIN_RE = /^\*?[A-Za-z0-9_@.-]{1,80}$/;
const SOURCE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const LISTEN_ADDRESS_RE = /^[A-Za-z0-9.:[\]-]{1,255}$/;
const MAX_NOTE_LENGTH = 500;

/** Matches no real owner/repo/login (every regex above rejects it), so a bad allowlist fails closed. */
export const POLICY_NO_MATCH = "!none";

export type PluginInstallMode = "disabled" | "catalog-only" | "allowed";

export interface PluginsPolicy {
  mode: "allowlist" | "blocklist";
  ids: string[];
}

export interface PluginInstallPolicy {
  mode: PluginInstallMode;
  /** Optional GitHub repo-path globs (`github.com/your-org/*`); only a trailing `*` segment is a wildcard. */
  sources?: string[];
}

export interface SyncPolicy {
  enabled?: boolean;
  providers?: string[];
  /** Exact hub origins (scheme + host + port), normalized with `URL.origin`. */
  hubAllowlist?: string[];
}

export interface ThreadTargetPolicy {
  enabled?: boolean;
  harnesses?: string[];
}

export interface RemoteDaemonTargetPolicy extends ThreadTargetPolicy {
  /** Exact `ws(s)://host:port` origins the remote daemon may use. */
  hosts?: string[];
}

export interface ThreadExecutionPolicy {
  /** Global harness allowlist across every target. */
  harnesses?: string[];
  machine?: ThreadTargetPolicy;
  localDaemon?: ThreadTargetPolicy;
  remoteDaemon?: RemoteDaemonTargetPolicy;
  hostExec?: { enabled?: boolean; allowAlways?: boolean };
  mobileRemoteAccess?: boolean;
}

export interface GithubPolicy {
  /** Machine file only: makes the settings form read-only. */
  settingsLocked?: boolean;
  /** Machine file only: pinned, beats env, vault `app.json` and `geode.json`. */
  clientId?: string;
  /** Machine file only: pinned, like `clientId`. */
  appSlug?: string;
  allowedOwners?: string[];
  allowedRepos?: string[];
  connect?: boolean;
  /** Machine file only. */
  disconnect?: boolean;
  allowedLogins?: string[];
  deliverToRemoteDaemon?: boolean;
}

export interface DaemonsPolicy {
  allowSchedule?: boolean;
  allowServe?: boolean;
  allowedListenAddresses?: string[];
}

export type VaultPolicyMode = "narrow" | "ignore";

/**
 * One policy document (the machine file, or a vault's `.geode/policy.json`).
 * Every area is optional; an absent area imposes no restriction.
 */
export interface ManagedPolicy {
  policyVersion: 1;
  plugins?: PluginsPolicy;
  pluginInstall?: PluginInstallPolicy;
  sync?: SyncPolicy;
  threadExecution?: ThreadExecutionPolicy;
  github?: GithubPolicy;
  daemons?: DaemonsPolicy;
  /** Machine file only: whether a vault's policy file is read at all. Default `narrow`. */
  vaultPolicy?: VaultPolicyMode;
  /** Display-only reason string (shown in the vault-policy notice). */
  note?: string;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function ignoreArea(area: string, why: string): void {
  console.error(`Managed policy: "${area}" ${why}; ignoring ${area} policy (fail open).`);
}

function dropField(field: string, why: string): void {
  console.warn(`Managed policy: "${field}" ${why}; ignoring this field (fail open).`);
}

/** Read an optional boolean field; a wrong type drops the field. */
function readBool(o: Obj, key: string, field: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  dropField(field, `must be a boolean, got ${JSON.stringify(v)}`);
  return undefined;
}

/**
 * Read an optional list field. `undefined` = absent or unusable (field
 * dropped, fail open). An empty array is kept: it means "nothing allowed".
 * A non-empty array with no valid entry is dropped too: keeping it would turn
 * a typo into a deny-all, which contradicts fail-open.
 */
function readList(o: Obj, key: string, field: string, accept: (s: string) => string | undefined): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    dropField(field, "must be an array");
    return undefined;
  }
  const out: string[] = [];
  for (const entry of v) {
    const ok = typeof entry === "string" ? accept(entry.trim()) : undefined;
    if (ok !== undefined) {
      if (!out.includes(ok)) out.push(ok);
    } else {
      console.warn(`Managed policy: skipping invalid entry ${JSON.stringify(entry)} in "${field}".`);
    }
  }
  if (v.length > 0 && out.length === 0) {
    dropField(field, "has no valid entries");
    return undefined;
  }
  return out;
}

/**
 * Like `readList`, but for the GitHub allowlists: present, non-null and
 * unusable (not an array, or non-empty with no valid entry) fails CLOSED by
 * becoming `[POLICY_NO_MATCH]`.
 */
function readClosedList(o: Obj, key: string, field: string, re: RegExp): string[] | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    console.error(`Managed policy: "${field}" must be an array; restricting everything (fail closed).`);
    return [POLICY_NO_MATCH];
  }
  const out: string[] = [];
  for (const entry of v) {
    const s = typeof entry === "string" ? entry.trim() : "";
    if (re.test(s)) {
      if (!out.includes(s)) out.push(s);
    } else {
      console.warn(`Managed policy: skipping invalid entry ${JSON.stringify(entry)} in "${field}".`);
    }
  }
  if (v.length > 0 && out.length === 0) {
    console.error(`Managed policy: "${field}" has no valid entries; restricting everything (fail closed).`);
    return [POLICY_NO_MATCH];
  }
  return out;
}

const tokenOf = (s: string): string | undefined => (TOKEN_RE.test(s) ? s : undefined);

function originOf(schemes: string[]): (s: string) => string | undefined {
  return (s) => {
    try {
      const u = new URL(s);
      if (!schemes.includes(u.protocol.slice(0, -1)) || !u.hostname) return undefined;
      return u.origin;
    } catch {
      return undefined;
    }
  };
}

function sourceOf(s: string): string | undefined {
  if (s.length === 0 || s.length > 200) return undefined;
  const segments = s.split("/");
  const ok = segments.every((seg, i) => (seg === "*" ? i === segments.length - 1 && i > 0 : SOURCE_SEGMENT_RE.test(seg)));
  return ok ? s : undefined;
}

function validatePlugins(raw: unknown): PluginsPolicy | undefined {
  if (!isObj(raw)) {
    ignoreArea("plugins", "is present but not an object");
    return undefined;
  }
  if (raw.mode !== "allowlist" && raw.mode !== "blocklist") {
    ignoreArea("plugins", `"mode" must be "allowlist" or "blocklist", got ${JSON.stringify(raw.mode)}`);
    return undefined;
  }
  if (!Array.isArray(raw.ids)) {
    ignoreArea("plugins", '"ids" must be an array');
    return undefined;
  }
  const ids: string[] = [];
  for (const id of raw.ids) {
    if (typeof id === "string" && ID_RE.test(id)) {
      ids.push(id);
    } else {
      console.warn(`Managed policy: skipping invalid plugin id ${JSON.stringify(id)} in "plugins.ids".`);
    }
  }
  return { mode: raw.mode, ids };
}

function validatePluginInstall(raw: unknown): PluginInstallPolicy | undefined {
  if (!isObj(raw)) {
    ignoreArea("pluginInstall", "is present but not an object");
    return undefined;
  }
  if (raw.mode !== "disabled" && raw.mode !== "catalog-only" && raw.mode !== "allowed") {
    ignoreArea("pluginInstall", `"mode" must be "disabled", "catalog-only" or "allowed", got ${JSON.stringify(raw.mode)}`);
    return undefined;
  }
  const out: PluginInstallPolicy = { mode: raw.mode };
  const sources = readList(raw, "sources", "pluginInstall.sources", sourceOf);
  if (sources) out.sources = sources;
  return out;
}

function validateSync(raw: unknown): SyncPolicy | undefined {
  if (!isObj(raw)) {
    ignoreArea("sync", "is present but not an object");
    return undefined;
  }
  const out: SyncPolicy = {};
  const enabled = readBool(raw, "enabled", "sync.enabled");
  if (enabled !== undefined) out.enabled = enabled;
  const providers = readList(raw, "providers", "sync.providers", tokenOf);
  if (providers) out.providers = providers;
  const hubs = readList(raw, "hubAllowlist", "sync.hubAllowlist", originOf(["https", "http", "wss", "ws"]));
  if (hubs) out.hubAllowlist = hubs;
  return out;
}

/** A target is `{ enabled?, harnesses? }`, or a bare boolean meaning `{ enabled }`. */
function validateTarget(raw: unknown, field: string, withHosts: boolean): RemoteDaemonTargetPolicy | undefined {
  if (typeof raw === "boolean") return { enabled: raw };
  if (!isObj(raw)) {
    dropField(field, "must be an object or a boolean");
    return undefined;
  }
  const out: RemoteDaemonTargetPolicy = {};
  const enabled = readBool(raw, "enabled", `${field}.enabled`);
  if (enabled !== undefined) out.enabled = enabled;
  const harnesses = readList(raw, "harnesses", `${field}.harnesses`, tokenOf);
  if (harnesses) out.harnesses = harnesses;
  if (withHosts) {
    const hosts = readList(raw, "hosts", `${field}.hosts`, originOf(["wss", "ws", "https", "http"]));
    if (hosts) out.hosts = hosts;
  }
  return out;
}

function validateThreadExecution(raw: unknown): ThreadExecutionPolicy | undefined {
  if (!isObj(raw)) {
    ignoreArea("threadExecution", "is present but not an object");
    return undefined;
  }
  const out: ThreadExecutionPolicy = {};
  const harnesses = readList(raw, "harnesses", "threadExecution.harnesses", tokenOf);
  if (harnesses) out.harnesses = harnesses;
  for (const key of ["machine", "localDaemon"] as const) {
    if (raw[key] === undefined) continue;
    const t = validateTarget(raw[key], `threadExecution.${key}`, false);
    if (t) out[key] = t;
  }
  if (raw.remoteDaemon !== undefined) {
    const t = validateTarget(raw.remoteDaemon, "threadExecution.remoteDaemon", true);
    if (t) out.remoteDaemon = t;
  }
  if (raw.hostExec !== undefined) {
    if (isObj(raw.hostExec)) {
      const hostExec: NonNullable<ThreadExecutionPolicy["hostExec"]> = {};
      const enabled = readBool(raw.hostExec, "enabled", "threadExecution.hostExec.enabled");
      if (enabled !== undefined) hostExec.enabled = enabled;
      const allowAlways = readBool(raw.hostExec, "allowAlways", "threadExecution.hostExec.allowAlways");
      if (allowAlways !== undefined) hostExec.allowAlways = allowAlways;
      out.hostExec = hostExec;
    } else {
      dropField("threadExecution.hostExec", "must be an object");
    }
  }
  const mobile = readBool(raw, "mobileRemoteAccess", "threadExecution.mobileRemoteAccess");
  if (mobile !== undefined) out.mobileRemoteAccess = mobile;
  return out;
}

function validateGithub(raw: unknown): GithubPolicy | undefined {
  if (!isObj(raw)) {
    ignoreArea("github", "is present but not an object");
    return undefined;
  }
  const out: GithubPolicy = {};
  for (const key of ["settingsLocked", "connect", "disconnect", "deliverToRemoteDaemon"] as const) {
    const v = readBool(raw, key, `github.${key}`);
    if (v !== undefined) out[key] = v;
  }
  for (const [key, re] of [["clientId", CLIENT_ID_RE], ["appSlug", SLUG_RE]] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === "string" && re.test(v.trim())) out[key] = v.trim();
    else dropField(`github.${key}`, "is not a valid value");
  }
  const owners = readClosedList(raw, "allowedOwners", "github.allowedOwners", OWNER_RE);
  if (owners) out.allowedOwners = owners;
  const repos = readClosedList(raw, "allowedRepos", "github.allowedRepos", REPO_RE);
  if (repos) out.allowedRepos = repos;
  const logins = readClosedList(raw, "allowedLogins", "github.allowedLogins", LOGIN_RE);
  if (logins) out.allowedLogins = logins;
  return out;
}

function validateDaemons(raw: unknown): DaemonsPolicy | undefined {
  if (!isObj(raw)) {
    ignoreArea("daemons", "is present but not an object");
    return undefined;
  }
  const out: DaemonsPolicy = {};
  for (const key of ["allowSchedule", "allowServe"] as const) {
    const v = readBool(raw, key, `daemons.${key}`);
    if (v !== undefined) out[key] = v;
  }
  const addresses = readList(raw, "allowedListenAddresses", "daemons.allowedListenAddresses", (s) =>
    LISTEN_ADDRESS_RE.test(s) ? s.toLowerCase() : undefined
  );
  if (addresses) out.allowedListenAddresses = addresses;
  return out;
}

/**
 * Parse and validate an already-`JSON.parse`d policy document. Never
 * throws — any structural problem (missing/unknown `policyVersion`,
 * invalid `mode`, non-array `ids`) causes the whole document, or just the
 * offending sub-section, to be treated as absent ("fail open"). A single
 * invalid entry inside a list is skipped with a logged warning rather than
 * invalidating the rest of the list. Each area is validated on its own, so a
 * broken `sync` block never disables a good `plugins` block.
 *
 * Returns `null` if the document is not usable at all.
 */
export function validatePolicy(raw: unknown): ManagedPolicy | null {
  if (!isObj(raw)) {
    console.error("Managed policy: file does not contain a JSON object; ignoring (fail open).");
    return null;
  }

  if (raw.policyVersion !== 1) {
    console.error(
      `Managed policy: missing or unrecognized policyVersion (${JSON.stringify(
        raw.policyVersion
      )}); ignoring (fail open).`
    );
    return null;
  }

  const policy: ManagedPolicy = { policyVersion: 1 };

  if (raw.plugins !== undefined) {
    const v = validatePlugins(raw.plugins);
    if (v) policy.plugins = v;
  }
  if (raw.pluginInstall !== undefined) {
    const v = validatePluginInstall(raw.pluginInstall);
    if (v) policy.pluginInstall = v;
  }
  if (raw.sync !== undefined) {
    const v = validateSync(raw.sync);
    if (v) policy.sync = v;
  }
  if (raw.threadExecution !== undefined) {
    const v = validateThreadExecution(raw.threadExecution);
    if (v) policy.threadExecution = v;
  }
  if (raw.github !== undefined) {
    const v = validateGithub(raw.github);
    if (v) policy.github = v;
  }
  if (raw.daemons !== undefined) {
    const v = validateDaemons(raw.daemons);
    if (v) policy.daemons = v;
  }
  if (raw.vaultPolicy !== undefined) {
    if (raw.vaultPolicy === "narrow" || raw.vaultPolicy === "ignore") policy.vaultPolicy = raw.vaultPolicy;
    else dropField("vaultPolicy", `must be "narrow" or "ignore", got ${JSON.stringify(raw.vaultPolicy)}`);
  }
  if (raw.note !== undefined) {
    if (typeof raw.note === "string" && raw.note.trim()) policy.note = raw.note.trim().slice(0, MAX_NOTE_LENGTH);
    else dropField("note", "must be a non-empty string");
  }

  return policy;
}

/**
 * Whether plugin `id` is blocked under a single-layer `policy`. `null` policy
 * (missing file, malformed, fail-open) or a policy with no `plugins` key never
 * blocks anything. For the machine+vault answer use `isPluginBlockedEffective`
 * in `./policy-layering`.
 */
export function isPluginBlocked(policy: ManagedPolicy | null, id: string): boolean {
  return pluginsPolicyBlocks(policy?.plugins, id);
}

/** Whether one layer's `plugins` block blocks `id`. */
export function pluginsPolicyBlocks(p: PluginsPolicy | undefined, id: string): boolean {
  if (!p) return false;
  const listed = p.ids.includes(id);
  return p.mode === "allowlist" ? !listed : listed;
}
