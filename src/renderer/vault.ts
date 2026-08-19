import { Events } from "./events";
import {
  TFile,
  TFolder,
  TAbstractFile,
  FileSystemAdapter,
  pathParent,
  pathName,
  splitExt,
  MARKDOWN_EXTENSIONS,
  isTFolder,
} from "./types";
import type { VaultFileEntry } from "../main/preload";

export interface DataWriteOptions {
  ctime?: number;
  mtime?: number;
}

/**
 * Renderer-side vault model. Mirrors the on-disk file tree, performs file
 * operations over IPC, and emits events: create, modify, delete, rename
 * (all with TFile/TFolder args).
 */
export class Vault extends Events {
  name = "";
  root = "";
  private files = new Map<string, TFile>();
  private folders = new Map<string, TFolder>();
  /** Content cache for markdown files, kept warm for search/metadata. */
  private contents = new Map<string, string>();

  async open(vaultPath: string): Promise<void> {
    const { root, name, files } = await window.geode.openVault(vaultPath);
    this.root = root;
    this.name = name;
    this.files.clear();
    this.folders.clear();
    this.contents.clear();
    this.folders.set("", { kind: "folder", path: "", name: name, parent: "", children: [] });
    for (const entry of files) this.indexEntry(entry);
    this.rebuildChildren();
    // Obsidian emits `create` while initially loading each existing abstract
    // file. Listeners that need to ignore this phase register after layout is
    // ready; listeners already attached to the Vault receive the loaded tree.
    for (const entry of files) {
      this.trigger("create", this.getAbstractFileByPath(entry.path));
    }
    window.geode.onVaultEvent(async (ev) => {
      if (ev.event === "create") {
        if (this.files.has(ev.path)) return;
        this.indexEntry({ path: ev.path, isFolder: false, mtime: Date.now(), ctime: Date.now(), size: 0 });
        this.rebuildChildren();
        this.contents.delete(ev.path);
        this.trigger("create", this.getFileByPath(ev.path));
      } else if (ev.event === "modify") {
        const f = this.files.get(ev.path);
        if (!f) return;
        f.mtime = Date.now();
        this.contents.delete(ev.path);
        this.trigger("modify", f);
      } else if (ev.event === "delete") {
        const f = this.files.get(ev.path);
        if (!f) return;
        this.files.delete(ev.path);
        this.contents.delete(ev.path);
        this.rebuildChildren();
        this.trigger("delete", f);
      } else if (ev.event === "create-folder") {
        if (this.folders.has(ev.path)) return;
        this.indexEntry({ path: ev.path, isFolder: true, mtime: Date.now(), ctime: Date.now(), size: 0 });
        this.rebuildChildren();
        this.trigger("create", this.folders.get(ev.path));
      } else if (ev.event === "delete-folder") {
        const f = this.folders.get(ev.path);
        if (!f) return;
        this.folders.delete(ev.path);
        this.rebuildChildren();
        this.trigger("delete", f);
      }
    });
  }

  private indexEntry(entry: VaultFileEntry) {
    if (entry.isFolder) {
      this.folders.set(entry.path, {
        kind: "folder",
        path: entry.path,
        name: pathName(entry.path),
        parent: pathParent(entry.path),
        children: [],
      });
    } else {
      const name = pathName(entry.path);
      const { basename, extension } = splitExt(name);
      this.files.set(entry.path, {
        kind: "file",
        path: entry.path,
        name,
        basename,
        extension,
        mtime: entry.mtime,
        ctime: entry.ctime,
        size: entry.size,
        parent: pathParent(entry.path),
      });
    }
  }

  /** Ensure every parent folder exists and recompute children arrays. */
  private rebuildChildren() {
    for (const f of [...this.files.values(), ...this.folders.values()]) {
      let parent = f.parent;
      while (parent && !this.folders.has(parent)) {
        this.folders.set(parent, {
          kind: "folder",
          path: parent,
          name: pathName(parent),
          parent: pathParent(parent),
          children: [],
        });
        parent = pathParent(parent);
      }
    }
    for (const folder of this.folders.values()) folder.children = [];
    const sortKey = (a: TAbstractFile) => a.name.toLowerCase();
    const all: TAbstractFile[] = [...this.folders.values(), ...this.files.values()];
    for (const item of all) {
      if (item.path === "") continue;
      const parent = this.folders.get((item as TFile | TFolder).parent);
      parent?.children.push(item);
    }
    for (const folder of this.folders.values()) {
      folder.children.sort((a, b) => {
        const af = this.folders.has(a.path) ? 0 : 1;
        const bf = this.folders.has(b.path) ? 0 : 1;
        if (af !== bf) return af - bf;
        return sortKey(a).localeCompare(sortKey(b));
      });
    }
  }

  getFileByPath(path: string): TFile | null {
    return this.files.get(path) ?? null;
  }

  getFolderByPath(path: string): TFolder | null {
    return this.folders.get(path === "/" ? "" : path) ?? null;
  }

  /**
   * Obsidian-compatible lookup returning either a file or folder at `path`,
   * or null. `normalizePath("")` (the empty/root folder path) resolves to
   * `"/"` in this repo (matching real Obsidian), but the root TFolder is
   * indexed internally under `""` — so `"/"` is treated as an alias for it
   * here. Without this, callers that normalize an empty/root folder setting
   * before looking it up (e.g. obsidian-daily-notes-interface's
   * `getAllDailyNotes`, called by the vendored Calendar plugin fixture) get
   * `null` instead of the root folder.
   */
  getAbstractFileByPath(path: string): TFile | TFolder | null {
    const key = path === "/" ? "" : path;
    return this.files.get(key) ?? this.folders.get(key) ?? null;
  }

  /** Cached `FileSystemAdapter`, rebuilt only when `this.root` changes. */
  private _adapter?: FileSystemAdapter;
  private _adapterRoot?: string;

  /**
   * Obsidian's `vault.adapter`. Plugins use it mainly for `getBasePath()`
   * (the vault's absolute filesystem path) to shell out with Node, plus
   * `getResourcePath()` to turn a vault-relative path into a loadable URL.
   *
   * Returns a real `FileSystemAdapter` instance (not a plain object) so that
   * plugin `adapter instanceof FileSystemAdapter` guards resolve — e.g.
   * obsidian-claude-threads uses that guard to derive a chat's working
   * directory, and falls back to the home directory when it fails. The
   * instance is memoized (rebuilt only if `this.root` changes) so repeated
   * `vault.adapter` reads return a stable reference. `getName`/`exists` are
   * injected as live closures, so they reflect the current vault name and
   * IPC `exists` at call time.
   */
  get adapter(): FileSystemAdapter {
    if (!this._adapter || this._adapterRoot !== this.root) {
      this._adapter = new FileSystemAdapter(this.root, {
        getName: () => this.name,
        exists: (p: string) => window.geode.exists(p),
      });
      this._adapterRoot = this.root;
    }
    return this._adapter;
  }

  getRoot(): TFolder {
    return this.folders.get("")!;
  }

  getName(): string {
    return this.name;
  }

  /**
   * Obsidian's `vault.getConfig(key)` reads a raw value out of the vault's
   * `.obsidian/app.json` (things like `"defaultViewMode"`,
   * `"readableLineLength"`). Geode has no such config store, so this is a
   * compat stub in the same spirit as `internalPlugins.getPluginById` for
   * ids other than `"daily-notes"`: real plugins call it unguarded (e.g.
   * the vendored Calendar fixture's `openOrCreateDailyNote` reads
   * `"defaultViewMode"` before opening a leaf), so it must exist and never
   * throw. Always returns `undefined` — callers already treat that as "no
   * preference set", Obsidian's own convention for an absent config key.
   */
  getConfig(_key: string): unknown {
    return undefined;
  }

  /**
   * Obsidian's `Vault.recurseChildren` static: depth-first visit every
   * descendant (files and folders) of `root`, calling `cb` on each. Real
   * plugins call this directly on the `Vault` class (not an instance) —
   * e.g. obsidian-daily-notes-interface's `getAllDailyNotes` uses it to
   * enumerate every file under the configured daily-notes folder.
   */
  static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => any): void {
    for (const child of root.children) {
      cb(child);
      if (isTFolder(child)) Vault.recurseChildren(child, cb);
    }
  }

  getFiles(): TFile[] {
    return [...this.files.values()];
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => MARKDOWN_EXTENSIONS.has(f.extension));
  }

  async cachedRead(file: TFile): Promise<string> {
    const cached = this.contents.get(file.path);
    if (cached !== undefined) return cached;
    const data = await window.geode.read(file.path);
    this.contents.set(file.path, data);
    return data;
  }

  /**
   * Synchronously return a file's content if it's already been warmed by a
   * prior `cachedRead()`/`read()` (no I/O, returns `undefined` if not yet
   * cached). Used by `MetadataCache` to build backlink context snippets
   * without turning that lookup into an async call — every markdown file
   * is already warmed by `MetadataCache.initialize()`/`indexFile()`.
   */
  getCachedContent(path: string): string | undefined {
    return this.contents.get(path);
  }

  /** Restore content bundled with a validated persistent metadata entry. */
  primeCachedContent(path: string, content: string): void {
    this.contents.set(path, content);
  }

  async read(file: TFile): Promise<string> {
    const data = await window.geode.read(file.path);
    this.contents.set(file.path, data);
    return data;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return window.geode.readBinary(file.path);
  }

  async create(path: string, data: string, _options?: DataWriteOptions): Promise<TFile> {
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
    const { mtime, ctime, size } = await window.geode.write(path, data);
    this.indexEntry({ path, isFolder: false, mtime, ctime, size });
    this.contents.set(path, data);
    this.rebuildChildren();
    const file = this.files.get(path)!;
    this.trigger("create", file);
    return file;
  }

  async createFolder(path: string): Promise<TFolder> {
    if (this.files.has(path) || this.folders.has(path)) {
      throw new Error(`Folder already exists: ${path}`);
    }
    await window.geode.mkdir(path);
    this.indexEntry({ path, isFolder: true, mtime: Date.now(), ctime: Date.now(), size: 0 });
    this.rebuildChildren();
    const folder = this.folders.get(path)!;
    this.trigger("create", folder);
    return folder;
  }

  async modify(file: TFile, data: string, _options?: DataWriteOptions): Promise<void> {
    const { mtime, size } = await window.geode.write(file.path, data);
    file.mtime = mtime;
    file.size = size;
    this.contents.set(file.path, data);
    this.trigger("modify", file);
  }

  async trash(item: TFile | TFolder): Promise<void> {
    await window.geode.trash(item.path);
    if (item.kind === "file") {
      this.files.delete(item.path);
      this.contents.delete(item.path);
    } else {
      // Drop the folder and everything beneath it.
      for (const p of [...this.files.keys()]) {
        if (p.startsWith(item.path + "/")) {
          this.files.delete(p);
          this.contents.delete(p);
        }
      }
      for (const p of [...this.folders.keys()]) {
        if (p === item.path || p.startsWith(item.path + "/")) this.folders.delete(p);
      }
    }
    this.rebuildChildren();
    this.trigger("delete", item);
  }

  /**
   * Updates `item`'s path/name/basename/extension/parent in place to reflect
   * a move, keeping the same object reference. Matches Obsidian's real
   * contract: TFile/TFolder are mutated on rename, not replaced, so plugin
   * code that holds a reference across a rename (a normal pattern) keeps
   * working against Geode the same way it does against real Obsidian.
   */
  private reindexInPlace(item: TFile | TFolder, newPath: string) {
    const name = pathName(newPath);
    item.path = newPath;
    item.name = name;
    item.parent = pathParent(newPath);
    if (item.kind === "file") {
      const { basename, extension } = splitExt(name);
      item.basename = basename;
      item.extension = extension;
    }
  }

  async rename(item: TFile | TFolder, newPath: string): Promise<void> {
    const oldPath = item.path;
    await window.geode.rename(oldPath, newPath);
    if (item.kind === "file") {
      this.files.delete(oldPath);
      const content = this.contents.get(oldPath);
      this.contents.delete(oldPath);
      this.reindexInPlace(item, newPath);
      item.mtime = Date.now();
      this.files.set(item.path, item);
      if (content !== undefined) this.contents.set(item.path, content);
      this.rebuildChildren();
      this.trigger("rename", item, oldPath);
    } else {
      // Collect the folder itself plus every descendant folder/file OBJECT
      // (not just path strings) before mutating any maps, so old-path
      // lookups below are unaffected by earlier deletions.
      const folderMoves: { obj: TFolder; oldP: string; newP: string }[] = [
        { obj: item, oldP: oldPath, newP: newPath },
      ];
      for (const p of this.folders.keys()) {
        if (p.startsWith(oldPath + "/")) {
          folderMoves.push({ obj: this.folders.get(p)!, oldP: p, newP: newPath + p.slice(oldPath.length) });
        }
      }
      const fileMoves: { obj: TFile; oldP: string; newP: string }[] = [];
      for (const p of this.files.keys()) {
        if (p.startsWith(oldPath + "/")) {
          fileMoves.push({ obj: this.files.get(p)!, oldP: p, newP: newPath + p.slice(oldPath.length) });
        }
      }

      for (const { oldP } of folderMoves) this.folders.delete(oldP);
      for (const { oldP } of fileMoves) this.files.delete(oldP);

      for (const m of folderMoves) {
        this.reindexInPlace(m.obj, m.newP);
        this.folders.set(m.obj.path, m.obj);
      }
      for (const m of fileMoves) {
        this.reindexInPlace(m.obj, m.newP);
        this.files.set(m.obj.path, m.obj);
        const content = this.contents.get(m.oldP);
        this.contents.delete(m.oldP);
        if (content !== undefined) this.contents.set(m.obj.path, content);
      }

      this.rebuildChildren();
      this.trigger("rename", folderMoves[0].obj, folderMoves[0].oldP);
      for (const m of fileMoves) this.trigger("rename", m.obj, m.oldP);
    }
  }

  /** Generate "Untitled", "Untitled 1", ... in the given folder. */
  availablePath(folder: string, base: string, ext: string): string {
    const prefix = folder ? folder + "/" : "";
    let candidate = `${prefix}${base}.${ext}`;
    let n = 1;
    while (this.files.has(candidate)) candidate = `${prefix}${base} ${n++}.${ext}`;
    return candidate;
  }
}
