import type { GeodeApi } from "../main/preload";
import type { HostServices } from "./host/contracts";

declare global {
  interface Window {
    geode: GeodeApi;
    hostServices?: HostServices;
  }
}

export interface TAbstractFile {
  path: string;
  name: string;
}

/**
 * Obsidian's `FileStats` — the `{ ctime, mtime, size }` bag hanging off
 * `TFile.stat` (ms epoch, bytes). See `docs/spec/03-plugin-api.md` § 2.7.
 */
export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export interface TFile extends TAbstractFile {
  kind: "file";
  basename: string;
  extension: string;
  mtime: number;
  ctime: number;
  size: number;
  parent: string; // folder path, "" for root
  /**
   * Obsidian-compat view over the flat fields above, which stay the canonical
   * storage for all core code. Read-only and non-enumerable — see
   * `attachFileStats`. `TFolder` has no counterpart, matching Obsidian.
   */
  readonly stat: FileStats;
}

export interface TFolder extends TAbstractFile {
  kind: "folder";
  parent: string;
  children: TAbstractFile[];
}

export type { Pos, Loc, LinkCache, TagCache, HeadingCache, SectionCache, ListItemCache, CachedMetadata, FootnoteRefCache, ReferenceLinkCache } from "../wiki/types";

export const MARKDOWN_EXTENSIONS = new Set(["md"]);
export const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
export const AUDIO_EXTENSIONS = new Set(["flac", "m4a", "mp3", "ogg", "wav", "3gp"]);
export const VIDEO_EXTENSIONS = new Set(["mkv", "mov", "mp4", "ogv", "webm"]);

/**
 * `TFile`/`TFolder` are plain interfaces here (see `kind` above), not
 * classes like Obsidian's — so plugin code can't do `instanceof TFile`.
 * These guards are the supported alternative and are part of the public
 * `geode` API surface (see `api/index.ts`).
 */
export function isTFile(item: TAbstractFile | null | undefined): item is TFile {
  return !!item && (item as TFile).kind === "file";
}

export function isTFolder(item: TAbstractFile | null | undefined): item is TFolder {
  return !!item && (item as TFolder).kind === "folder";
}

/**
 * Give a freshly built file object its Obsidian-compat `stat`. Called from the
 * single place `TFile`s are constructed (`Vault.indexEntry`); rename reindexes
 * the same object in place, so the property outlives a move.
 *
 * Two deliberate choices here:
 *
 * 1. **Live, not a snapshot.** `mtime`/`ctime`/`size` are assigned directly on
 *    the indexed object by the watcher, `modify` and `rename`. A plain
 *    `stat: { ...entry }` captured at construction would keep serving the
 *    numbers the file had when it was first indexed — plugins would silently
 *    read stale timestamps, which is worse than the `undefined` throw this
 *    replaces. The fields are therefore getters onto the owning file. The
 *    `stat` object itself is stable (`file.stat === file.stat`), as in Obsidian.
 *
 * 2. **Non-enumerable**, so this stays a zero-diff addition to every existing
 *    serialization. One core path does `JSON.stringify` a real `TFile` today:
 *    `bases/query-engine.ts` builds a group bucket id from a `BaseValue`, whose
 *    union includes `{ type: "file"; value: TFile }`. An enumerable `stat`
 *    would add a `"stat":{...}` segment to those ids. Nothing *persists* a
 *    `TFile` — workspace layout stores `PersistedLeaf.file` as a path string,
 *    the metadata cache stores `PersistedMetadataEntry`, the vault manifest
 *    stores `VaultFileEntry`, and `src/renderer/sync/` never references `TFile`
 *    at all — but `Plugin.saveData` and `App.saveLocalStorage` will persist
 *    whatever a plugin hands them.
 *
 *    The sharper reason is (1): enumeration is what copies. `{...file}` and
 *    `structuredClone` evaluate the getters once and freeze the result, so an
 *    enumerable `stat` would quietly reintroduce the stale snapshot this design
 *    exists to avoid. Property reads, `file.stat.mtime` and
 *    `Object.getOwnPropertyDescriptor` all work regardless — only enumeration
 *    skips it — and `stat` still serializes on its own
 *    (`JSON.stringify(file.stat)`) for plugins that actually want it.
 */
export function attachFileStats(file: Omit<TFile, "stat">): TFile {
  const stat: FileStats = {
    get ctime() { return file.ctime; },
    get mtime() { return file.mtime; },
    get size() { return file.size; },
  };
  Object.defineProperty(file, "stat", { value: stat, enumerable: false, configurable: true });
  return file as TFile;
}

/**
 * `TFile`/`TFolder` runtime classes for the Obsidian-compat surface. Geode
 * represents files/folders as plain objects discriminated by `kind`, so
 * rather than rewrite the whole vault to construct class instances, these
 * classes customise `instanceof` via `Symbol.hasInstance`: any object with
 * the right `kind` satisfies `obj instanceof TFile`/`TFolder`, which is how
 * Obsidian plugins (Claude Threads included) test file types. Exported to
 * plugins as `TFile`/`TFolder` from `api/obsidian.ts`.
 */
export class TFileClass {
  static [Symbol.hasInstance](obj: unknown): boolean {
    return isTFile(obj as TAbstractFile);
  }
}

export class TFolderClass {
  static [Symbol.hasInstance](obj: unknown): boolean {
    return isTFolder(obj as TAbstractFile);
  }
}

/**
 * Obsidian's `FileSystemAdapter`: the desktop/Node filesystem adapter
 * exposed as `vault.adapter`. Plugins use it mainly for `getBasePath()` (the
 * vault's absolute filesystem path, to shell out with Node) and
 * `getResourcePath()` (turn a vault-relative path into a loadable URL), and
 * critically test `adapter instanceof FileSystemAdapter` to decide whether
 * they're running on desktop with real fs access (obsidian-claude-threads
 * does exactly this to derive a chat's working directory). For that guard to
 * resolve, `vault.adapter` MUST be a real instance of this class.
 *
 * Lives in this leaf module (alongside `TFileClass`/`TFolderClass`) rather
 * than in `api/obsidian.ts` so that `vault.ts` can construct it without
 * importing `api/obsidian.ts` — that would form an import cycle, since
 * `api/obsidian.ts` already re-exports `Vault` from `vault.ts`. It is
 * re-exported to plugins as `FileSystemAdapter` from `api/obsidian.ts`.
 *
 * Behaviour is injected via the constructor (`getName`/`exists`) so this
 * module stays dependency-free; safe defaults keep any bare
 * `new FileSystemAdapter(basePath)` construction working.
 */
/** Obsidian's `adapter.list()` result: the direct children of a folder, split by kind. */
export interface ListedFiles {
  files: string[];
  folders: string[];
}

export interface DataAdapterOptions {
  getName?: () => string;
  exists?: (normalizedPath: string) => Promise<boolean> | boolean;
  rmdir?: (normalizedPath: string, recursive: boolean) => Promise<void>;
  list?: (normalizedPath: string) => Promise<ListedFiles>;
}

export class DataAdapter {
  private readonly nameProvider: () => string;
  private readonly existsProvider: (normalizedPath: string) => Promise<boolean> | boolean;
  private readonly rmdirProvider: (normalizedPath: string, recursive: boolean) => Promise<void>;
  private readonly listProvider: (normalizedPath: string) => Promise<ListedFiles>;

  constructor(opts?: DataAdapterOptions) {
    this.nameProvider = opts?.getName ?? (() => "");
    this.existsProvider = opts?.exists ?? (() => false);
    this.rmdirProvider = opts?.rmdir ?? ((normalizedPath) => Promise.reject(
      new Error(`Vault.adapter.rmdir is not supported on this platform (cannot remove "${normalizedPath}")`)
    ));
    this.listProvider = opts?.list ?? ((normalizedPath) => Promise.reject(
      new Error(`Vault.adapter.list is not supported on this platform (cannot list "${normalizedPath}")`)
    ));
  }

  getName(): string {
    return this.nameProvider();
  }

  exists(normalizedPath: string): Promise<boolean> | boolean {
    return this.existsProvider(normalizedPath);
  }

  /**
   * Obsidian's `adapter.rmdir(normalizedPath, recursive)`: remove a folder
   * from the vault outright — no trip through the OS trash, unlike
   * `Vault.trash`. Plugins call this to clean up folders they created
   * themselves; obsidian-claude-threads removes a thread's attachment folder
   * this way when the thread is hard-deleted, and without it the folder leaked
   * on disk forever (the missing method threw, and the caller swallowed it).
   *
   * Rejects rather than resolving when the path escapes the vault, names the
   * vault root, is not a folder, or — with `recursive` false — is not empty.
   */
  rmdir(normalizedPath: string, recursive = false): Promise<void> {
    return this.rmdirProvider(normalizedPath, recursive);
  }

  /**
   * Obsidian's `adapter.list(normalizedPath)`: the direct children of a
   * folder, split into `files` and `folders` (full vault-relative paths, not
   * bare names) — Node's `fs.readdir(dir, { withFileTypes: true })`
   * semantics, not a recursive whole-vault walk. Distinct from
   * `VaultFilesService.list()` (used internally to seed/sync the whole
   * vault), which is flat and recursive.
   *
   * Rejects when `normalizedPath` does not exist or is not a folder, so
   * callers can tell "empty folder" apart from "no such folder".
   */
  list(normalizedPath: string): Promise<ListedFiles> {
    return this.listProvider(normalizedPath);
  }
}

export class FileSystemAdapter extends DataAdapter {
  /** Absolute vault path. Public because real Obsidian exposes it directly. */
  basePath: string;
  constructor(basePath: string, opts?: DataAdapterOptions) {
    super(opts);
    this.basePath = basePath;
  }

  getBasePath(): string {
    return this.basePath;
  }

  getFullPath(relativePath: string): string {
    return `${this.basePath}/${relativePath}`;
  }

  getResourcePath(normalizedPath: string): string {
    return `file://${encodeFileUrlPath(`${this.basePath}/${normalizedPath}`)}`;
  }

}

/**
 * Percent-encode a filesystem path for use in a `file://` URL, one segment at a
 * time so the separators survive.
 *
 * Escaping only spaces (the previous behaviour) is not enough: `#` starts a
 * fragment, so `Board/photo#1.png` used to yield a URL truncated at `photo`,
 * and `?` would open a query string. Both silently resolve to "file not found"
 * — an `<img>` that never loads with nothing in the console explaining why.
 * `encodeURIComponent` still renders a space as `%20`, so ordinary paths are
 * byte-for-byte unchanged.
 */
export function encodeFileUrlPath(absolutePath: string): string {
  return absolutePath.split("/").map(encodeURIComponent).join("/");
}

/**
 * Obsidian's `normalizePath`: normalise a vault-relative path — backslashes
 * to slashes, collapse duplicate slashes, strip a leading `./` and trailing
 * slash. Returns "/" for an empty result.
 */
export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").trim();
  p = p.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

export function pathParent(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

export function pathName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

export function splitExt(name: string): { basename: string; extension: string } {
  const i = name.lastIndexOf(".");
  if (i <= 0) return { basename: name, extension: "" };
  return { basename: name.slice(0, i), extension: name.slice(i + 1).toLowerCase() };
}
