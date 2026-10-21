/**
 * General-purpose fresh-vault seeding mechanism (see
 * docs/adr/0014-default-vault-seeding.md). Lets a deploying organization
 * customize their own build by dropping a default theme and/or a default
 * plugin list into `resources/` *before* running
 * `npm run build`/`electron-builder` — this repo ships neither. Every
 * upstream user's build has no `resources/default-theme/` and no
 * `resources/default-plugins.json`, so both steps below are no-ops and
 * every vault opens exactly as it does today.
 *
 * The equivalent of shipping a pre-set `appearance.json` +
 * `community-plugins.json` for a fresh Obsidian vault. Geode has no
 * existing first-run/bootstrap mechanism for this (verified:
 * `PluginManager.initialize()` only enables plugins already present under
 * `.geode/plugins/`; nothing auto-installs from GitHub). This is the
 * smallest reasonable addition: it reuses the app's EXISTING
 * "install plugin/theme from GitHub" pipeline (`installCommunity` in
 * ./community.ts) rather than building a new distribution mechanism.
 *
 * Gated strictly on `.geode/` not existing yet at the vault root, so this
 * NEVER touches a vault that has already been opened by Geode once —
 * including vaults created before this mechanism existed. Runs during
 * `open-vault`, in the main process, before that IPC handler returns to the
 * renderer — so `PluginManager.initialize()` and `ThemeManager.apply()` (both
 * renderer-side, and both running after `open-vault` resolves) see any
 * seeded files on their very first read. No race is possible: nothing writes
 * `.geode/` before this runs (config files are created lazily, and the
 * renderer's settings/workspace autosave paths only fire after `open-vault`
 * has already returned).
 *
 * Since ADR 0050 the two resources are translated into an in-memory vault
 * pack and applied through `applyVaultPack` (the same staged, allowlisted
 * path a `.vault` file takes); behavior is unchanged.
 *
 * Each of the two seeding steps (theme, plugins) is independently
 * try/caught — a failure in one (missing files, a malformed
 * default-plugins.json, a permission error) must never block the other, and
 * neither may ever block opening the vault itself. Per-plugin install
 * failures (offline, rate-limited, repo moved) are logged and skipped, not
 * thrown, for the same reason: a flaky network must never block opening a
 * vault.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { installCommunity as defaultInstallCommunity } from "./community";
import type { ResolveOpts } from "./github-resolve";
import { applyVaultPack, buildMemoryPack } from "./vault-pack";

interface DefaultPluginsFile {
  plugins: string[];
}

/** The subset of `installCommunity`'s signature this module depends on — overridable in tests to avoid real GitHub network calls. */
export type InstallCommunityFn = (
  root: string,
  specInput: string,
  opts: ResolveOpts
) => Promise<{ id: string }>;

export interface BootstrapFreshVaultDeps {
  installCommunity?: InstallCommunityFn;
}

/**
 * esbuild bundles main-process code to `dist/main.js`, so `__dirname` is
 * `<repo>/dist` at runtime in both dev and packaged builds — the same
 * convention `main.ts` already uses for `resources/icon.png`.
 *
 * `GEODE_RESOURCES_DIR` overrides this so unit tests can point at a temp
 * directory instead of the repo's real `resources/` folder — mirroring the
 * existing `GEODE_POLICY_PATH` (main.ts) / `GEODE_GITHUB_API_BASE`
 * (community.ts) test/dev override precedent. Never set in production.
 */
function resourcesDir(): string {
  return process.env.GEODE_RESOURCES_DIR || path.join(__dirname, "..", "resources");
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Reads `resources/default-theme/<ThemeName>/{theme.css,manifest.json}` into
 * pack files under `.geode/themes/<ThemeName>/`, if (and only if) a deploying
 * organization has dropped a theme folder into `resources/default-theme/`
 * before building. `<ThemeName>` is discovered from the directory itself —
 * nothing here hardcodes an organization's theme name. If more than one
 * theme folder is present, the alphabetically first is used (this mechanism
 * seeds exactly one default theme, same as the design it was generalized
 * from).
 *
 * Returns the theme's folder name (used to select it in `.geode/app.json`),
 * or `undefined` if there's nothing to copy — the expected, common case for
 * every regular upstream user, so this logs nothing in that case.
 */
async function readDefaultTheme(files: Map<string, Buffer>): Promise<string | undefined> {
  const themesRoot = path.join(resourcesDir(), "default-theme");
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(themesRoot, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }

  const themeName = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()[0];
  if (!themeName) return undefined;

  const srcDir = path.join(themesRoot, themeName);
  const read = new Map<string, Buffer>();
  for (const file of ["theme.css", "manifest.json"]) {
    read.set(`.geode/themes/${themeName}/${file}`, await fsp.readFile(path.join(srcDir, file)));
  }
  // Only add once both files were read, so a half-readable theme is never seeded.
  for (const [k, v] of read) files.set(k, v);
  return themeName;
}

/**
 * Reads `resources/default-plugins.json` (shape: `{ "plugins": string[] }`,
 * each entry an `"owner/repo"` GitHub reference).
 *
 * Returns `null` if the file doesn't exist — the expected, common case for
 * every regular upstream user.
 */
async function readDefaultPluginRepos(): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(resourcesDir(), "default-plugins.json"), "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }

  const parsed = JSON.parse(raw) as DefaultPluginsFile;
  return Array.isArray(parsed?.plugins) ? parsed.plugins : [];
}

/**
 * `theme: "light"` alongside `cssTheme` is required for the seeded theme to
 * actually take visual effect: `AppSettings`' own in-memory default is
 * `theme: "dark"` (src/renderer/app.ts) with `cssTheme: ""`, and a community
 * theme's `theme.css` conventionally targets `body.theme-light` (the
 * Obsidian/Geode CSS-variable contract scopes color tokens by the active
 * `theme-light`/`theme-dark` body class — see styles/app.css). Without this,
 * the copied theme would sit unused under `.geode/themes/` while the vault
 * still rendered in dark mode. This still matches current `AppSettings`
 * defaults as of this repo's current version — verified against
 * `src/renderer/app.ts`'s `settings` initializer, not assumed.
 */
function appConfigFile(themeName: string): Buffer {
  return Buffer.from(JSON.stringify({ theme: "light", cssTheme: themeName }, null, 2), "utf8");
}

/**
 * If `root` has never been opened as a Geode vault before (no `.geode/`
 * folder yet), seed it with whatever a deploying organization has dropped
 * into `resources/default-theme/` and/or `resources/default-plugins.json`
 * ahead of their build. No-op for any vault that already has a `.geode/`
 * folder, and a no-op step-by-step for whichever of those two resources is
 * absent — which, for every upstream build of this repo, is both of them.
 * Never throws — each input is individually guarded so a failure reading
 * one still lets the other (and vault opening itself) proceed, and GitHub
 * plugin install failures are skipped rather than aborting the seed.
 */
export async function bootstrapFreshVault(root: string, deps: BootstrapFreshVaultDeps = {}): Promise<void> {
  if (fs.existsSync(path.join(root, ".geode"))) return;

  const files = new Map<string, Buffer>();

  let themeName: string | undefined;
  try {
    themeName = await readDefaultTheme(files);
  } catch (err) {
    console.error("Failed to install default theme", err);
  }

  let repos: string[] | null = null;
  try {
    repos = await readDefaultPluginRepos();
  } catch (err) {
    console.error("Failed to install default plugin set", err);
  }

  if (themeName) files.set(".geode/app.json", appConfigFile(themeName));
  if (files.size === 0 && repos === null) return;

  // default-plugins.json entries have no id until installCommunity resolves
  // them, so they ride along as `unresolvedGithubPlugins` rather than manifest entries.
  const pack = buildMemoryPack({ id: "geode-default-seed", name: "Default vault seed", files });
  try {
    await applyVaultPack({ kind: "memory", pack }, root, {
      requireEmptyDest: false,
      githubFailure: "skip",
      pluginsJson: repos !== null ? "always" : "when-needed",
      installCommunity: deps.installCommunity ?? defaultInstallCommunity,
      unresolvedGithubPlugins: repos ?? [],
    });
  } catch (err) {
    console.error("Failed to seed default vault contents", err);
  }
}
