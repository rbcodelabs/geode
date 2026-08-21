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
  /** theme names already present under `.geode/themes/`. */
  existingGeodeThemes: string[];
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
  /** Full enabled-plugin id list to persist to `.geode/plugins.json`. */
  enabledPluginIds: string[];
  /** Theme name to set as active (`cssTheme`), or null to leave unchanged. */
  activeTheme: string | null;
  /** Items intentionally not imported, with a human-readable reason. */
  skipped: SkippedItem[];
}

/**
 * Pure planner: decide what to copy, which plugins to enable, and which theme
 * to apply. Never mutates its input.
 *
 * Rules:
 *  - a plugin is importable only if it has BOTH manifest.json and main.js;
 *  - a theme is importable only if it has a theme.css;
 *  - an item already present in `.geode/` is NOT overwritten (skipped as
 *    "already present"), but a plugin already on disk still counts as
 *    installed when computing the enabled set;
 *  - the enabled set = the plugins already enabled in Geode (order preserved),
 *    then plugins Obsidian had enabled (in Obsidian's order), deduped and
 *    filtered to plugins that will exist in `.geode/` after the copy;
 *  - the active theme is set only when Obsidian had one AND it will exist in
 *    `.geode/`; otherwise null (never clobber Geode's current theme with none).
 */
export function planObsidianImport(input: ImportPlanInput): ImportPlan {
  const skipped: SkippedItem[] = [];

  // --- plugins ---------------------------------------------------------------
  const existingPlugins = new Set(input.existingGeodePlugins);
  const pluginsToCopy: PlannedCopy[] = [];
  // Every plugin id that will exist under .geode/plugins/ after the import:
  // the ones already there, plus every importable Obsidian one.
  const willExistPlugins = new Set(input.existingGeodePlugins);

  for (const p of input.obsidianPlugins) {
    if (!p.hasManifest || !p.hasMain) {
      skipped.push({
        kind: "plugin",
        name: p.id,
        reason: "missing manifest.json or main.js",
      });
      continue;
    }
    willExistPlugins.add(p.id);
    if (existingPlugins.has(p.id)) {
      skipped.push({
        kind: "plugin",
        name: p.id,
        reason: "already present in .geode/plugins/ — left as-is",
      });
      continue;
    }
    pluginsToCopy.push({ name: p.id });
  }

  // Enabled set: keep the plugins Geode already had enabled (in order), then
  // append the plugins Obsidian had enabled (in Obsidian's order). Dedupe, and
  // drop any id that won't actually exist on disk after the import.
  const enabledPluginIds: string[] = [];
  const seenEnabled = new Set<string>();
  for (const id of [...input.enabledInGeode, ...input.enabledInObsidian]) {
    if (seenEnabled.has(id)) continue;
    if (!willExistPlugins.has(id)) continue;
    seenEnabled.add(id);
    enabledPluginIds.push(id);
  }

  // --- themes ----------------------------------------------------------------
  const existingThemes = new Set(input.existingGeodeThemes);
  const themesToCopy: PlannedCopy[] = [];
  const willExistThemes = new Set(input.existingGeodeThemes);

  for (const t of input.obsidianThemes) {
    if (!t.hasThemeCss) {
      skipped.push({ kind: "theme", name: t.name, reason: "missing theme.css" });
      continue;
    }
    willExistThemes.add(t.name);
    if (existingThemes.has(t.name)) {
      skipped.push({
        kind: "theme",
        name: t.name,
        reason: "already present in .geode/themes/ — left as-is",
      });
      continue;
    }
    themesToCopy.push({ name: t.name });
  }

  // Set the active theme only when Obsidian had one AND it will exist in
  // .geode/ — never clobber Geode's current theme with "none".
  const activeTheme =
    input.activeThemeInObsidian && willExistThemes.has(input.activeThemeInObsidian)
      ? input.activeThemeInObsidian
      : null;

  return { pluginsToCopy, themesToCopy, enabledPluginIds, activeTheme, skipped };
}

/** Result the executor returns to the renderer after the copy completes. */
export interface ObsidianImportResult {
  /** Plugin ids newly copied into `.geode/plugins/`. */
  plugins: string[];
  /** Theme names newly copied into `.geode/themes/`. */
  themes: string[];
  /** Full enabled-plugin id list the renderer should persist + enable. */
  enabledPluginIds: string[];
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
 * Copy the whitelisted `files` that exist in `srcDir` into `destDir`,
 * atomically: files are written to a sibling staging dir on the same volume,
 * then renamed into place, so a failure never leaves a half-written item.
 * Returns true if the required `entryFile` was present and copied.
 */
async function copyItem(
  srcDir: string,
  parentDir: string,
  name: string,
  files: readonly string[],
  entryFile: string
): Promise<boolean> {
  await fsp.mkdir(parentDir, { recursive: true });
  const staging = await fsp.mkdtemp(path.join(parentDir, ".import-"));
  try {
    let wroteEntry = false;
    for (const file of files) {
      const from = path.join(srcDir, file);
      if (!(await exists(from))) continue;
      await fsp.copyFile(from, path.join(staging, file));
      if (file === entryFile) wroteEntry = true;
    }
    if (!wroteEntry) {
      await fsp.rm(staging, { recursive: true, force: true });
      return false;
    }
    const destDir = path.join(parentDir, name);
    await fsp.rm(destDir, { recursive: true, force: true });
    await fsp.rename(staging, destDir);
    return true;
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
  const existingGeodeThemes: string[] = [];
  for (const name of await listDirNames(path.join(geodeDir, "themes"))) {
    if (await exists(path.join(geodeDir, "themes", name, "theme.css"))) existingGeodeThemes.push(name);
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
    enabledInGeode,
  });

  // --- execute the copies ----------------------------------------------------
  const copiedPlugins: string[] = [];
  for (const { name: id } of plan.pluginsToCopy) {
    const ok = await copyItem(
      path.join(obsidianPluginsDir, id),
      path.join(geodeDir, "plugins"),
      id,
      PLUGIN_FILES,
      "main.js"
    );
    if (ok) copiedPlugins.push(id);
  }

  const copiedThemes: string[] = [];
  for (const { name } of plan.themesToCopy) {
    const source = themeSources.get(name);
    if (!source) continue;
    if (await copyTheme(source, path.join(geodeDir, "themes"), name)) copiedThemes.push(name);
  }

  return {
    plugins: copiedPlugins,
    themes: copiedThemes,
    enabledPluginIds: plan.enabledPluginIds,
    activeTheme: plan.activeTheme,
    skipped: plan.skipped,
  };
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
): Promise<boolean> {
  await fsp.mkdir(parentDir, { recursive: true });
  const staging = await fsp.mkdtemp(path.join(parentDir, ".import-"));
  try {
    if (!(await exists(source.cssPath))) {
      await fsp.rm(staging, { recursive: true, force: true });
      return false;
    }
    await fsp.copyFile(source.cssPath, path.join(staging, "theme.css"));
    if (source.manifestPath && (await exists(source.manifestPath))) {
      await fsp.copyFile(source.manifestPath, path.join(staging, "manifest.json"));
    }
    const destDir = path.join(parentDir, name);
    await fsp.rm(destDir, { recursive: true, force: true });
    await fsp.rename(staging, destDir);
    return true;
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw err;
  }
}
