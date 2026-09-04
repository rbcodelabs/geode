/**
 * Import community plugins & themes from an existing Obsidian `.obsidian/`
 * folder into Geode's `.geode/` (roadmap item 87c6f0de; opportunity: "Users
 * can't get plugins/themes into a Geode vault without hand-copying files").
 *
 * When Geode is pointed at a vault that an Obsidian user already populated,
 * their community plugins live under `<vault>/.obsidian/plugins/<id>/` and
 * themes under `<vault>/.obsidian/themes/<name>/` — folders Geode never reads
 * (it only looks at `.geode/`). This module copies those into `.geode/`,
 * preserving which plugins were enabled (`.obsidian/community-plugins.json`)
 * and which theme was active (`.obsidian/appearance.json` `cssTheme`).
 *
 * The split mirrors the sibling install-from-GitHub feature:
 *   - the PURE planner (`planObsidianImport`) decides what to copy / enable /
 *     apply, given only plain data — NO fs, NO electron, NO DOM — so it is
 *     fully unit-testable in the node vitest env;
 *   - the I/O executor (`importFromObsidianVault`) does the directory walk and
 *     the atomic file copy in the main process (Node).
 *
 * Like `community.ts`, the executor copies files ONLY. It never writes
 * `.geode/plugins.json` or `.geode/app.json` — the renderer owns those
 * (PluginManager persists the enabled set; App.settings holds `cssTheme`), per
 * the sources-of-truth split documented in community/store.ts. The executor
 * returns the merged enabled-list and the theme-to-apply for the renderer to
 * act on.
 */

import * as path from "node:path";
import * as fsp from "node:fs/promises";

export type ImportItemType = "plugin" | "theme";

/** A plugin folder discovered under `.obsidian/plugins/`. */
export interface ObsidianPluginEntry {
  id: string;
  hasManifest: boolean;
  hasMain: boolean;
}

/** A theme discovered under `.obsidian/themes/` (folder with a theme.css). */
export interface ObsidianThemeEntry {
  name: string;
  hasThemeCss: boolean;
}

/** Everything the pure planner needs — gathered by the executor via real I/O. */
export interface ImportPlanInput {
  obsidianPlugins: ObsidianPluginEntry[];
  obsidianThemes: ObsidianThemeEntry[];
  /** ids from `.obsidian/community-plugins.json` (plugins Obsidian had enabled). */
  enabledInObsidian: string[];
  /** `cssTheme` from `.obsidian/appearance.json` ("" = default/none). */
  activeThemeInObsidian: string;
  /** plugin ids already present under `.geode/plugins/`. */
  existingGeodePlugins: string[];
  /**
   * EVERY name already occupied under `.geode/themes/` — every directory
   * regardless of its contents, plus any bare `<name>.css` file. This is the
   * overwrite guard, so it must be exhaustive: a directory that happens not to
   * contain a `theme.css` (an interrupted install, a hand-edited theme, a theme
   * that ships `manifest.json` + `assets/`) still owns its name and must never
   * be clobbered.
   */
  existingGeodeThemes: string[];
  /**
   * Subset of `existingGeodeThemes` that is actually renderable today (has a
   * `theme.css`). Only used to decide whether an already-present theme may be
   * made active — never as an overwrite guard. Defaults to
   * `existingGeodeThemes` when omitted.
   */
  renderableGeodeThemes?: string[];
  /** plugin ids already enabled in `.geode/plugins.json`. */
  enabledInGeode: string[];
}

export interface PlannedCopy {
  /** Plugin id or theme folder name. */
  name: string;
}

export interface SkippedItem {
  kind: ImportItemType;
  name: string;
  reason: string;
}

export interface ImportPlan {
  /** Plugin ids to copy from `.obsidian` → `.geode` (excludes already-present). */
  pluginsToCopy: PlannedCopy[];
  /** Theme names to copy. */
  themesToCopy: PlannedCopy[];
  /**
   * The merged view of "what is enabled after this import" — Geode's existing
   * enabled ids followed by the ids Obsidian had enabled, deduped and filtered
   * to plugins that exist on disk. INFORMATIONAL ONLY: it necessarily includes
   * plugins that were already installed in Geode, whose enabled/disabled state
   * is the user's own decision and must not be changed by an import. Never
   * feed this list to `enable()` — use `pluginsToEnable`.
   */
  enabledPluginIds: string[];
  /**
   * The ids this import may actually turn on: plugins THIS import copies in
   * that Obsidian had enabled. A plugin already present in `.geode/plugins/`
   * never appears here, so an import can never resurrect a plugin the user
   * deliberately disabled in Geode.
   */
  pluginsToEnable: string[];
  /** Theme name to set as active (`cssTheme`), or null to leave unchanged. */
  activeTheme: string | null;
  /** Items intentionally not imported, with a human-readable reason. */
  skipped: SkippedItem[];
}

/**
 * Fold a plugin id / theme folder name to the key the filesystem actually
 * compares on. macOS (APFS/HFS+) is case-insensitive AND unicode-normalizing,
 * so `MyPlugin`, `myplugin` and an NFD-encoded `Café` all name the SAME
 * directory. Exact-string comparison misses that, which is how an
 * "already present, never overwrite" guard can end up deleting a live install.
 */
export function normalizeItemKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Reason text for a name that is already taken on disk under a different
 * spelling — keeps the on-disk name visible so the user can see what it
 * collided with (e.g. Geode installs `Dataview` by manifest id, Obsidian
 * installs `dataview`).
 */
function collisionReason(kind: ImportItemType, incoming: string, existing: string): string {
  const where = kind === "plugin" ? ".geode/plugins/" : ".geode/themes/";
  return existing === incoming
    ? `already present in ${where} — left as-is`
    : `already present as "${existing}" in ${where} (case/unicode variant of "${incoming}") — left as-is`;
}

/**
 * Pure planner: decide what to copy, which plugins to enable, and which theme
 * to apply. Never mutates its input.
 *
 * Rules:
 *  - a plugin is importable only if it has BOTH manifest.json and main.js;
 *  - a theme is importable only if it has a theme.css;
 *  - an item whose name is already taken in `.geode/` is NOT overwritten
 *    (skipped as "already present"), but a plugin already on disk still counts
 *    as installed when computing the merged enabled view. "Already taken" is
 *    decided on the case-folded, NFC-normalized name, because that is what the
 *    filesystem compares on — see `normalizeItemKey`;
 *  - `enabledPluginIds` = the plugins already enabled in Geode (order
 *    preserved), then plugins Obsidian had enabled (in Obsidian's order),
 *    deduped and filtered to plugins that will exist in `.geode/` after the
 *    copy. It describes state; it is NOT an instruction to enable;
 *  - `pluginsToEnable` = the plugins this import copies in that Obsidian had
 *    enabled. Only these may be switched on; an import never changes the
 *    enabled state of a plugin that was already installed in Geode;
 *  - the active theme is set only when Obsidian had one AND a renderable theme
 *    of that name will exist in `.geode/`; otherwise null (never clobber
 *    Geode's current theme with none).
 */
export function planObsidianImport(input: ImportPlanInput): ImportPlan {
  const skipped: SkippedItem[] = [];

  // --- plugins ---------------------------------------------------------------
  // Keyed by the filesystem-equivalent name, not the raw string, so a
  // case/unicode variant of an installed plugin is recognized as "already
  // present" instead of being copied over the top of it.
  const takenPluginNames = new Map<string, string>();
  for (const id of input.existingGeodePlugins) takenPluginNames.set(normalizeItemKey(id), id);

  const pluginsToCopy: PlannedCopy[] = [];
  // key → the id that will name the directory under .geode/plugins/ after the
  // import: the already-installed spelling when there is one, else the
  // Obsidian spelling we're about to copy in.
  const willExistPlugins = new Map(takenPluginNames);

  for (const p of input.obsidianPlugins) {
    if (!p.hasManifest || !p.hasMain) {
      skipped.push({
        kind: "plugin",
        name: p.id,
        reason: "missing manifest.json or main.js",
      });
      continue;
    }
    const key = normalizeItemKey(p.id);
    const taken = takenPluginNames.get(key);
    if (taken !== undefined) {
      skipped.push({ kind: "plugin", name: p.id, reason: collisionReason("plugin", p.id, taken) });
      continue;
    }
    // Claim the name so a second Obsidian folder that only differs by case
    // (`Foo` and `foo`) can't have both copies race for the same destination.
    takenPluginNames.set(key, p.id);
    willExistPlugins.set(key, p.id);
    pluginsToCopy.push({ name: p.id });
  }

  // Enabled set: keep the plugins Geode already had enabled (in order), then
  // append the plugins Obsidian had enabled (in Obsidian's order). Dedupe, and
  // drop any id that won't actually exist on disk after the import. This is the
  // informational merged view only — see `pluginsToEnable` for what may be
  // switched on.
  const enabledPluginIds: string[] = [];
  const seenEnabled = new Set<string>();
  for (const id of [...input.enabledInGeode, ...input.enabledInObsidian]) {
    const key = normalizeItemKey(id);
    const actual = willExistPlugins.get(key);
    if (actual === undefined) continue;
    if (seenEnabled.has(key)) continue;
    seenEnabled.add(key);
    enabledPluginIds.push(actual);
  }

  // What the import is allowed to actually turn on: only plugins it copies in
  // itself. A plugin already installed in Geode keeps whatever enabled state
  // the user last chose — an import must never re-enable (and therefore
  // re-execute) something they deliberately switched off.
  const enabledObsidianKeys = new Set(input.enabledInObsidian.map(normalizeItemKey));
  const pluginsToEnable = pluginsToCopy
    .map((p) => p.name)
    .filter((id) => enabledObsidianKeys.has(normalizeItemKey(id)));

  // --- themes ----------------------------------------------------------------
  const renderable = input.renderableGeodeThemes ?? input.existingGeodeThemes;
  // Every name occupied under .geode/themes/, whatever it holds — the guard.
  const takenThemeNames = new Map<string, string>();
  for (const name of input.existingGeodeThemes) takenThemeNames.set(normalizeItemKey(name), name);
  // Names that can legitimately be made the active theme after the import.
  const usableThemes = new Map<string, string>();
  for (const name of renderable) usableThemes.set(normalizeItemKey(name), name);

  const themesToCopy: PlannedCopy[] = [];

  for (const t of input.obsidianThemes) {
    if (!t.hasThemeCss) {
      skipped.push({ kind: "theme", name: t.name, reason: "missing theme.css" });
      continue;
    }
    const key = normalizeItemKey(t.name);
    const taken = takenThemeNames.get(key);
    if (taken !== undefined) {
      skipped.push({ kind: "theme", name: t.name, reason: collisionReason("theme", t.name, taken) });
      continue;
    }
    takenThemeNames.set(key, t.name);
    usableThemes.set(key, t.name);
    themesToCopy.push({ name: t.name });
  }

  // Set the active theme only when Obsidian had one AND a renderable theme of
  // that name will exist in .geode/ — never clobber Geode's current theme with
  // "none". Resolve to the on-disk spelling, which may differ in case.
  const activeTheme = input.activeThemeInObsidian
    ? usableThemes.get(normalizeItemKey(input.activeThemeInObsidian)) ?? null
    : null;

  return { pluginsToCopy, themesToCopy, enabledPluginIds, pluginsToEnable, activeTheme, skipped };
}

/** Result the executor returns to the renderer after the copy completes. */
export interface ObsidianImportResult {
  /** Plugin ids newly copied into `.geode/plugins/`. */
  plugins: string[];
  /** Theme names newly copied into `.geode/themes/`. */
  themes: string[];
  /**
   * Merged "what is enabled after this import" view, for display/persistence.
   * NOT an instruction to enable — see `pluginsToEnable`.
   */
  enabledPluginIds: string[];
  /**
   * The only ids the renderer may `enable()`: plugins this run actually copied
   * in that Obsidian had enabled.
   */
  pluginsToEnable: string[];
  /** Theme to apply, or null to leave the current theme unchanged. */
  activeTheme: string | null;
  /** Items skipped, with reasons (already present / malformed). */
  skipped: SkippedItem[];
}

/** Files copied for a plugin (whitelist — never build paths from disk names). */
const PLUGIN_FILES = ["manifest.json", "main.js", "styles.css", "data.json"] as const;

async function exists(p: string): Promise<boolean> {
  return fsp
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * True if anything at all occupies `p` — including a broken symlink, which
 * `access()` reports as absent but `rename()` would happily replace. Used as
 * the "is the destination free?" check, so it must not follow links.
 */
async function pathIsOccupied(p: string): Promise<boolean> {
  return fsp
    .lstat(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * True only for a real, regular file. `copyFile` follows symlinks, so a
 * whitelisted `data.json` that is a symlink to (say) `~/.ssh/id_rsa` would
 * otherwise copy that file's *contents* into the vault. Sources are attacker-
 * influenced (any `.obsidian/` folder a user opens), so only regular files are
 * ever read.
 */
async function isRegularFile(p: string): Promise<boolean> {
  return fsp
    .lstat(p)
    .then((st) => st.isFile())
    .catch(() => false);
}

async function readJsonArray(file: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function readCssTheme(file: string): Promise<string> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    const v = (parsed as { cssTheme?: unknown })?.cssTheme;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

async function listDirNames(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Guard an id/name derived from disk before it is used as a directory name. */
function isSafeName(name: string): boolean {
  return Boolean(name) && !name.includes("/") && !name.includes("\\") && !name.includes("..") && !name.startsWith(".");
}

/**
 * Outcome of a single staged copy.
 * - `copied` — the item landed at its destination.
 * - `missing-entry` — the source lacked its required entry file, so nothing
 *   was written (the planner filters these out; reaching it means the source
 *   changed under us).
 * - `destination-exists` — something already occupies the destination. The
 *   planner is supposed to make this unreachable, so hitting it means a race
 *   or a guard bug — which must resolve to "leave the user's data alone", not
 *   "delete it".
 */
type CopyOutcome = "copied" | "missing-entry" | "destination-exists";

/**
 * Move a fully-populated staging dir into place, or give up.
 *
 * This deliberately does NOT clear the destination first. An earlier version
 * called `fsp.rm(destDir, {recursive: true, force: true})` here, which turned
 * every gap in the "already present" guard into silent, unrecoverable deletion
 * of an installed plugin/theme and its `data.json`. `rename(2)` refuses to
 * replace a non-empty directory anyway, so there is nothing to gain and a
 * user's install to lose.
 */
async function commitStaging(staging: string, destDir: string): Promise<CopyOutcome> {
  if (await pathIsOccupied(destDir)) {
    await fsp.rm(staging, { recursive: true, force: true });
    return "destination-exists";
  }
  try {
    await fsp.rename(staging, destDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Lost a race between the check above and the rename.
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      await fsp.rm(staging, { recursive: true, force: true });
      return "destination-exists";
    }
    throw err;
  }
  return "copied";
}

/**
 * Copy the whitelisted `files` that exist in `srcDir` into `<parentDir>/<name>`,
 * atomically: files are written to a sibling staging dir on the same volume,
 * then renamed into place, so a failure never leaves a half-written item.
 * Only regular files are copied — symlinks in the source are ignored.
 */
async function copyItem(
  srcDir: string,
  parentDir: string,
  name: string,
  files: readonly string[],
  entryFile: string
): Promise<CopyOutcome> {
  await fsp.mkdir(parentDir, { recursive: true });
  const staging = await fsp.mkdtemp(path.join(parentDir, ".import-"));
  try {
    let wroteEntry = false;
    for (const file of files) {
      const from = path.join(srcDir, file);
      if (!(await isRegularFile(from))) continue;
      await fsp.copyFile(from, path.join(staging, file));
      if (file === entryFile) wroteEntry = true;
    }
    if (!wroteEntry) {
      await fsp.rm(staging, { recursive: true, force: true });
      return "missing-entry";
    }
    return await commitStaging(staging, path.join(parentDir, name));
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw err;
  }
}

/**
 * I/O executor: read the vault's `.obsidian/` folder, plan the import, copy the
 * whitelisted files into `.geode/`, and return what happened. Copies files
 * only — the renderer persists the enabled list and applies the theme.
 *
 * Safe to call when there is no `.obsidian/` folder (returns an empty result).
 */
export async function importFromObsidianVault(root: string): Promise<ObsidianImportResult> {
  const obsidianDir = path.join(root, ".obsidian");
  const geodeDir = path.join(root, ".geode");
  const empty: ObsidianImportResult = {
    plugins: [],
    themes: [],
    enabledPluginIds: [],
    pluginsToEnable: [],
    activeTheme: null,
    skipped: [],
  };
  if (!(await exists(obsidianDir))) return empty;

  // --- discover Obsidian plugins --------------------------------------------
  const obsidianPluginsDir = path.join(obsidianDir, "plugins");
  const obsidianPlugins: ObsidianPluginEntry[] = [];
  for (const id of await listDirNames(obsidianPluginsDir)) {
    if (!isSafeName(id)) continue;
    const dir = path.join(obsidianPluginsDir, id);
    obsidianPlugins.push({
      id,
      hasManifest: await exists(path.join(dir, "manifest.json")),
      hasMain: await exists(path.join(dir, "main.js")),
    });
  }

  // --- discover Obsidian themes (modern folder + legacy single-file) ---------
  const obsidianThemesDir = path.join(obsidianDir, "themes");
  const obsidianThemes: ObsidianThemeEntry[] = [];
  // name → where this theme's files live on disk, so the copy step can handle
  // both the modern `<name>/theme.css` layout and the legacy `<name>.css` file.
  const themeSources = new Map<string, { cssPath: string; manifestPath?: string }>();
  let themeEntries: import("node:fs").Dirent[] = [];
  try {
    themeEntries = await fsp.readdir(obsidianThemesDir, { withFileTypes: true });
  } catch {
    themeEntries = [];
  }
  for (const entry of themeEntries) {
    if (entry.isDirectory()) {
      if (!isSafeName(entry.name)) continue;
      const cssPath = path.join(obsidianThemesDir, entry.name, "theme.css");
      const hasThemeCss = await exists(cssPath);
      obsidianThemes.push({ name: entry.name, hasThemeCss });
      if (hasThemeCss) {
        const manifestPath = path.join(obsidianThemesDir, entry.name, "manifest.json");
        themeSources.set(entry.name, {
          cssPath,
          manifestPath: (await exists(manifestPath)) ? manifestPath : undefined,
        });
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".css")) {
      // Legacy Obsidian theme: a bare `<name>.css` file.
      const name = entry.name.slice(0, -".css".length);
      if (!isSafeName(name)) continue;
      obsidianThemes.push({ name, hasThemeCss: true });
      themeSources.set(name, { cssPath: path.join(obsidianThemesDir, entry.name) });
    }
  }

  // --- read Obsidian enabled/active state + existing Geode state -------------
  const enabledInObsidian = await readJsonArray(path.join(obsidianDir, "community-plugins.json"));
  const activeThemeInObsidian = await readCssTheme(path.join(obsidianDir, "appearance.json"));
  const existingGeodePlugins = await listDirNames(path.join(geodeDir, "plugins"));
  // The overwrite guard has to see EVERY name that is taken under
  // .geode/themes/, not just the ones that look like a finished theme. A dir
  // holding manifest.json + assets/ but no theme.css (interrupted install,
  // hand-edited theme, `theme.css.bak`) still owns its name.
  const geodeThemesDir = path.join(geodeDir, "themes");
  const existingGeodeThemes: string[] = [];
  const renderableGeodeThemes: string[] = [];
  let geodeThemeEntries: import("node:fs").Dirent[] = [];
  try {
    geodeThemeEntries = await fsp.readdir(geodeThemesDir, { withFileTypes: true });
  } catch {
    geodeThemeEntries = [];
  }
  for (const entry of geodeThemeEntries) {
    if (entry.isDirectory()) {
      existingGeodeThemes.push(entry.name);
      if (await exists(path.join(geodeThemesDir, entry.name, "theme.css"))) {
        renderableGeodeThemes.push(entry.name);
      }
    } else if (entry.name.toLowerCase().endsWith(".css")) {
      // A bare `<name>.css` occupies `<name>` too — importing a `<name>/`
      // folder alongside it would be ambiguous at best.
      existingGeodeThemes.push(entry.name.slice(0, -".css".length));
    }
  }
  const enabledInGeode = await readJsonArray(path.join(geodeDir, "plugins.json"));

  // --- plan ------------------------------------------------------------------
  const plan = planObsidianImport({
    obsidianPlugins,
    obsidianThemes,
    enabledInObsidian,
    activeThemeInObsidian,
    existingGeodePlugins,
    existingGeodeThemes,
    renderableGeodeThemes,
    enabledInGeode,
  });

  // --- execute the copies ----------------------------------------------------
  // The plan already excludes anything already present; these outcome branches
  // only fire when the source or destination changed underneath us mid-import.
  const skipped: SkippedItem[] = [...plan.skipped];
  const copiedPlugins: string[] = [];
  for (const { name: id } of plan.pluginsToCopy) {
    const outcome = await copyItem(
      path.join(obsidianPluginsDir, id),
      path.join(geodeDir, "plugins"),
      id,
      PLUGIN_FILES,
      "main.js"
    );
    if (outcome === "copied") copiedPlugins.push(id);
    else skipped.push({ kind: "plugin", name: id, reason: copyFailureReason("plugin", outcome) });
  }

  const copiedThemes: string[] = [];
  for (const { name } of plan.themesToCopy) {
    const source = themeSources.get(name);
    if (!source) {
      skipped.push({ kind: "theme", name, reason: "source files disappeared before the copy" });
      continue;
    }
    const outcome = await copyTheme(source, geodeThemesDir, name);
    if (outcome === "copied") copiedThemes.push(name);
    else skipped.push({ kind: "theme", name, reason: copyFailureReason("theme", outcome) });
  }

  // Only plugins that really landed on disk may be enabled.
  const copiedPluginKeys = new Set(copiedPlugins.map(normalizeItemKey));
  const pluginsToEnable = plan.pluginsToEnable.filter((id) =>
    copiedPluginKeys.has(normalizeItemKey(id))
  );

  // Don't promise a theme that was never copied (and wasn't already there).
  const planned = plan.activeTheme;
  const plannedKey = planned === null ? "" : normalizeItemKey(planned);
  const themeIsOnDisk =
    planned !== null &&
    (copiedThemes.some((n) => normalizeItemKey(n) === plannedKey) ||
      renderableGeodeThemes.some((n) => normalizeItemKey(n) === plannedKey));
  const activeTheme = themeIsOnDisk ? planned : null;

  return {
    plugins: copiedPlugins,
    themes: copiedThemes,
    enabledPluginIds: plan.enabledPluginIds,
    pluginsToEnable,
    activeTheme,
    skipped,
  };
}

/** Human-readable reason for a copy that didn't land, for `skipped[]`. */
function copyFailureReason(kind: ImportItemType, outcome: Exclude<CopyOutcome, "copied">): string {
  const where = kind === "plugin" ? ".geode/plugins/" : ".geode/themes/";
  return outcome === "destination-exists"
    ? `already present in ${where} — left as-is (destination appeared during the import)`
    : kind === "plugin"
      ? "source lost its main.js before it could be copied"
      : "source lost its theme.css before it could be copied";
}

/**
 * Copy a single theme into `<parentDir>/<name>/theme.css` (+ manifest.json if
 * present), atomically via a staging dir. Handles both the modern folder
 * layout and the legacy bare-`.css` file, since the source paths are resolved
 * by the caller.
 */
async function copyTheme(
  source: { cssPath: string; manifestPath?: string },
  parentDir: string,
  name: string
): Promise<CopyOutcome> {
  await fsp.mkdir(parentDir, { recursive: true });
  const staging = await fsp.mkdtemp(path.join(parentDir, ".import-"));
  try {
    if (!(await isRegularFile(source.cssPath))) {
      await fsp.rm(staging, { recursive: true, force: true });
      return "missing-entry";
    }
    await fsp.copyFile(source.cssPath, path.join(staging, "theme.css"));
    if (source.manifestPath && (await isRegularFile(source.manifestPath))) {
      await fsp.copyFile(source.manifestPath, path.join(staging, "manifest.json"));
    }
    return await commitStaging(staging, path.join(parentDir, name));
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw err;
  }
}
