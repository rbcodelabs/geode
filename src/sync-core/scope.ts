export interface SyncScope {
  markdown: boolean; images: boolean; audio: boolean; video: boolean; pdfs: boolean; other: boolean;
  mainSettings: boolean; appearance: boolean; themesAndSnippets: boolean; hotkeys: boolean;
  corePlugins: boolean; communityPlugins: boolean; communityPluginData: boolean;
  excludedFolders: string[];
  /**
   * The host exchanges configuration as plain FILES under `.geode/` and `.obsidian/` (the headless host)
   * rather than as projected documents (`editor.json` ...) owned by a running app. Optional and omitted by
   * the app, so the app's scope key is unchanged.
   */
  rawConfig?: boolean;
}

export const DEFAULT_SYNC_SCOPE: Readonly<SyncScope> = Object.freeze({
  markdown: true, images: true, audio: true, video: true, pdfs: true, other: true,
  mainSettings: true, appearance: true, themesAndSnippets: true, hotkeys: true,
  corePlugins: true, communityPlugins: false, communityPluginData: false, excludedFolders: [],
});

// `.geode-sync-tmp` is the headless host's same-volume apply staging directory.
const RESERVED = [".geode/sync", ".geode-trash", ".trash", ".geode-sync-tmp"];
const CONFIG_RULES: Array<[RegExp, keyof SyncScope]> = [
  [/^\.geode\/app\.json$/i, "mainSettings"], [/^\.geode\/appearance\.json$/i, "appearance"],
  [/^\.geode\/(themes|snippets)\//i, "themesAndSnippets"], [/^\.geode\/hotkeys\.json$/i, "hotkeys"],
  [/^\.geode\/(core-plugins|daily-notes)\.json$/i, "corePlugins"],
  [/^\.geode\/community-plugins\.json$/i, "communityPlugins"], [/^\.geode\/plugins\//i, "communityPluginData"],
];
/** The same allowlist for an Obsidian-compatible config folder. Used by hosts that sync config as raw files. */
const OBSIDIAN_CONFIG_RULES: Array<[RegExp, keyof SyncScope]> = [
  [/^\.obsidian\/app\.json$/i, "mainSettings"], [/^\.obsidian\/appearance\.json$/i, "appearance"],
  [/^\.obsidian\/(themes|snippets)\//i, "themesAndSnippets"], [/^\.obsidian\/hotkeys\.json$/i, "hotkeys"],
  [/^\.obsidian\/(core-plugins|daily-notes)\.json$/i, "corePlugins"],
  [/^\.obsidian\/community-plugins\.json$/i, "communityPlugins"], [/^\.obsidian\/plugins\//i, "communityPluginData"],
];
/** Folder names that never travel, however deep (dependency trees and caches). */
const NEVER_SYNCED_SEGMENTS = new Set(["node_modules", "cache", "caches"]);

/** Config roots a raw-file host may walk. */
export const CONFIG_ROOTS: readonly string[] = [".geode", ".obsidian"];

/**
 * Direct children of a config root that are rebuildable or machine-local state and never travel:
 * `.geode/metadata-cache/` holds the SQLite index and cache.json (hundreds of MB, rewritten constantly,
 * rebuilt from the vault on every device). Not a user scope choice: no flag turns these on.
 */
const LOCAL_ONLY_CONFIG_CHILDREN = new Set(["metadata-cache"]);
/** Atomic-write leftovers (`x.tmp`, `.x.tmp-<pid>-<uuid>`, `.cache.x.tmp`): half-written by definition. */
const TEMP_FILE_NAME = /\.tmp(?:-[^/]*)?$/i;

/**
 * True for a path inside a config root that must never be synchronised, whatever the scope says. Accepts
 * every spelling a config path takes on its way through the engine: physical (`.geode/metadata-cache/x`),
 * raw resource (`raw.geode/metadata-cache/x`) and the root-relative form the app uses for projected
 * config (`metadata-cache/x`). Only meaningful for configuration paths: a user's content folder may
 * legitimately be called `metadata-cache`, so content-namespace paths are never passed here.
 */
export function isLocalOnlyConfigPath(path: string): boolean {
  const parts = path.split("/");
  if (CONFIG_ROOTS.includes(parts[0]) || Object.hasOwn(RAW_ROOT, parts[0])) parts.shift();
  if (parts.length === 0) return false;
  if (LOCAL_ONLY_CONFIG_CHILDREN.has(parts[0].toLowerCase())) return true;
  return parts.some(part => TEMP_FILE_NAME.test(part));
}

/**
 * Which scope flag governs a vault-relative path under `.geode/` or `.obsidian/`, or null when the path is
 * not portable configuration (workspace*.json, caches, `.geode/sync`, any other dotted path). Pure path
 * classification: whether that flag is ON is the caller's scope, not decided here.
 */
export function portableConfigCategory(path: string): keyof SyncScope | null {
  try { validateSyncPath(path); } catch { return null; }
  if (isLocalOnlyConfigPath(path)) return null;
  const parts = path.split("/");
  if (parts.slice(1).some(part => part.startsWith(".") || NEVER_SYNCED_SEGMENTS.has(part.toLowerCase()))) return null;
  const rule = [...CONFIG_RULES, ...OBSIDIAN_CONFIG_RULES].find(([pattern]) => pattern.test(path));
  return rule ? rule[1] : null;
}

export function validateSyncPath(path: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.normalize("NFC") !== path) throw new Error(`Unsafe sync path: ${path}`);
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error(`Unsafe sync path: ${path}`);
  const lower = path.toLocaleLowerCase("en-US");
  if (RESERVED.some(prefix => lower === prefix || lower.startsWith(`${prefix}/`))) throw new Error(`Reserved sync path: ${path}`);
  return path;
}

export function isPathInSyncScope(path: string, scope: Readonly<SyncScope>): boolean {
  try { validateSyncPath(path); } catch { return false; }
  if (scope.excludedFolders.some(folder => path === folder || path.startsWith(`${folder}/`))) return false;
  if (path.split("/").slice(1).some(part => part.startsWith("."))) return false;
  if (path.startsWith(".")) {
    if (isLocalOnlyConfigPath(path)) return false;
    const rule = CONFIG_RULES.find(([pattern]) => pattern.test(path));
    return rule ? Boolean(scope[rule[1]]) : false;
  }
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["md", "markdown", "canvas", "base"].includes(ext)) return scope.markdown;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "heic"].includes(ext)) return scope.images;
  if (["mp3", "wav", "m4a", "ogg", "flac"].includes(ext)) return scope.audio;
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return scope.video;
  if (ext === "pdf") return scope.pdfs;
  return scope.other;
}

/**
 * Portable-config resources normally live under `.geode/` and are named relative to it (`themes/x.css`).
 * A raw-file host also exchanges config files that are not themes/snippets. History record names may not be
 * `.geode` or `.obsidian`, so those files travel under a first segment that stands in for the config root:
 *   .geode/app.json                    <->  raw.geode/app.json
 *   .obsidian/plugins/x/data.json      <->  raw.obsidian/plugins/x/data.json
 * Neither form can collide with a projected document name (`editor.json`) or an asset path (`themes/...`).
 */
const RAW_SEGMENT: Record<string, string> = { ".geode": "raw.geode", ".obsidian": "raw.obsidian" };
const RAW_ROOT = Object.fromEntries(Object.entries(RAW_SEGMENT).map(([root, segment]) => [segment, root]));

/** `.obsidian/a` -> `raw.obsidian/a`; null when the path is not under a config root. */
export function rawResourcePath(physical: string): string | null {
  const [head, ...rest] = physical.split("/");
  return RAW_SEGMENT[head] ? [RAW_SEGMENT[head], ...rest].join("/") : null;
}
/** `raw.obsidian/a` -> `.obsidian/a`; null when the path is not in raw form. */
export function rawPhysicalPath(resource: string): string | null {
  const [head, ...rest] = resource.split("/");
  return RAW_ROOT[head] ? [RAW_ROOT[head], ...rest].join("/") : null;
}
/** The naming test only; `rawConfigCategory` is the validity test. */
export const isRawConfigResourcePath = (path: string): boolean => rawPhysicalPath(path) !== null;

/**
 * Validity and governing flag of a raw config resource path, file or folder: a file the allowlist classifies,
 * a folder that can contain such files, or one of the two roots ("root", governed by `rawConfig` alone).
 * Null when the path may never travel.
 */
export function rawConfigCategory(resource: string): keyof SyncScope | "root" | null {
  const physical = rawPhysicalPath(resource);
  if (physical === null || isLocalOnlyConfigPath(physical)) return null;
  if (CONFIG_ROOTS.includes(physical)) return "root";
  return portableConfigCategory(physical) ?? portableConfigCategory(`${physical}/x`);
}

/** The vault-relative path a portable-config resource path is stored at. */
export const portableResourcePhysicalPath = (path: string): string => rawPhysicalPath(path) ?? `.geode/${path}`;
