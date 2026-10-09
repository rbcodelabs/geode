export interface SyncScope {
  markdown: boolean; images: boolean; audio: boolean; video: boolean; pdfs: boolean; other: boolean;
  mainSettings: boolean; appearance: boolean; themesAndSnippets: boolean; hotkeys: boolean;
  corePlugins: boolean; communityPlugins: boolean; communityPluginData: boolean;
  excludedFolders: string[];
}

export const DEFAULT_SYNC_SCOPE: Readonly<SyncScope> = Object.freeze({
  markdown: true, images: true, audio: true, video: true, pdfs: true, other: true,
  mainSettings: true, appearance: true, themesAndSnippets: true, hotkeys: true,
  corePlugins: true, communityPlugins: false, communityPluginData: false, excludedFolders: [],
});

const RESERVED = [".geode/sync", ".geode-trash", ".trash"];
const CONFIG_RULES: Array<[RegExp, keyof SyncScope]> = [
  [/^\.geode\/app\.json$/i, "mainSettings"], [/^\.geode\/appearance\.json$/i, "appearance"],
  [/^\.geode\/(themes|snippets)\//i, "themesAndSnippets"], [/^\.geode\/hotkeys\.json$/i, "hotkeys"],
  [/^\.geode\/(core-plugins|daily-notes)\.json$/i, "corePlugins"],
  [/^\.geode\/community-plugins\.json$/i, "communityPlugins"], [/^\.geode\/plugins\//i, "communityPluginData"],
];

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
