import { Events } from "./events";
import {
  TFile,
  TFolder,
  TAbstractFile,
  DataAdapter,
  FileSystemAdapter,
  pathParent,
  pathName,
  splitExt,
  MARKDOWN_EXTENSIONS,
  isTFolder,
} from "./types";
import type { HostServices, VaultEvent, VaultFileEntry } from "./host/contracts";
import { getHostServices } from "./host/registry";
import { measureOperation } from "./perf-instrumentation";
import {
  buildVaultManifest,
  diffVaultManifests,
  reduceProviderEvents,
  type ReconcileChange,
  type VaultManifest,
} from "./reconciliation";

export interface DataWriteOptions {
  ctime?: number;
  mtime?: number;
}

/**
 * Bounded content cache with least-recently-used eviction. Backs
 * `cachedRead`/`getCachedContent`/`primeCachedContent`: without a cap, this
 * map re-accumulates the whole vault's text unboundedly — the indexer's own
 * wire format no longer carries content (see the SQLite metadata-store
 * migration), but `search-view.ts`'s full-text search independently
 * re-warms every markdown file's content on a single plain-text query, which
 * would otherwise reproduce the same unbounded-growth pattern here. `get`
 * refreshes an entry's recency; `set` evicts the least-recently-used entry
 * once the cap is exceeded.
 */
class LruContentCache {
  private map = new Map<string, string>();

  constructor(private readonly maxEntries: number) {}

  get(path: string): string | undefined {
    const value = this.map.get(path);
    if (value === undefined) return undefined;
    // Re-insert to mark as most-recently-used (Map iteration/insertion order).
    this.map.delete(path);
    this.map.set(path, value);
    return value;
  }

  set(path: string, value: string): void {
    this.map.delete(path);
    this.map.set(path, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(path: string): void {
    this.map.delete(path);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Cap on the number of files' content kept warm at once — see `LruContentCache`. */
const CONTENT_CACHE_MAX_ENTRIES = 2_000;

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
  /** Content cache for markdown files, kept warm for search/metadata. LRU-capped — see `LruContentCache`. */
  private contents = new LruContentCache(CONTENT_CACHE_MAX_ENTRIES);
  private stopHostChanges: (() => void) | null = null;
  private mutationSequence = 0;
  private ownMutationIds = new Set<string>();
  private pendingHostEvents: VaultEvent[] = [];
  private hostEventFlushScheduled = false;
  private hasDurableReconcileBaseline = false;
  private acknowledgedPathsSinceManifest = new Set<string>();

  constructor(readonly host: HostServices = getHostServices()) {
    super();
  }

  async open(vaultPath: string): Promise<void> {
    this.stopHostChanges?.();
    this.stopHostChanges = null;
    this.ownMutationIds.clear();
    this.acknowledgedPathsSinceManifest.clear();
    const { root, name } = await measureOperation("vault-discovery-ipc", () =>
      this.host.vaultRegistry.openVault(vaultPath)
    );
    const files = await this.host.vaultFiles.list();
    this.root = root;
    this.name = name;
    this.files.clear();
    this.folders.clear();
    this.contents.clear();
    this.folders.set("", { kind: "folder", path: "", name: name, parent: "", children: [] });
    for (const entry of files) this.indexEntry(entry);
    this.rebuildChildren();
    let storedManifest: unknown = null;
    try {
      storedManifest = await this.host.config.read(this.reconcileManifestKey());
    } catch {
      // Legacy/third-party host fixtures without config persistence can still
      // open. Reconciliation remains unavailable until the host supplies it.
    }
    this.hasDurableReconcileBaseline = this.isValidManifest(storedManifest);
    try {
      if (!this.hasDurableReconcileBaseline) {
        await this.host.config.write(this.reconcileManifestKey(), buildVaultManifest(root, files));
      }
    } catch {
      // The manifest is derived. A host without device-config persistence can
      // still open safely; the next complete reconciliation retries it.
    }
    // Obsidian emits `create` while initially loading each existing abstract
    // file. Listeners that need to ignore this phase register after layout is
    // ready; listeners already attached to the Vault receive the loaded tree.
    for (const entry of files) {
      this.trigger("create", this.getAbstractFileByPath(entry.path));
    }
    this.stopHostChanges = this.host.vaultFiles.onChange((ev) => {
      if (ev.mutationId && this.ownMutationIds.has(ev.mutationId)) return;
      this.pendingHostEvents.push(ev);
      if (this.hostEventFlushScheduled) return;
      this.hostEventFlushScheduled = true;
      queueMicrotask(() => {
        this.hostEventFlushScheduled = false;
        const events = reduceProviderEvents(this.pendingHostEvents);
        this.pendingHostEvents = [];
        for (const event of events) this.applyHostChange(event);
      });
    });
  }

  private applyHostChange(ev: VaultEvent): void {
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
  }

  private reconcileManifestKey(): string {
    return `device-reconcile:${encodeURIComponent(this.root)}`;
  }

  private isValidManifest(value: unknown): value is VaultManifest {
    if (!value || typeof value !== "object") return false;
    const manifest = value as Partial<VaultManifest>;
    return manifest.version === 1 && manifest.vaultId === this.root &&
      !!manifest.entries && typeof manifest.entries === "object";
  }

  needsInitialReconcile(): boolean {
    return this.hasDurableReconcileBaseline;
  }

  private currentManifest(): VaultManifest {
    const entries: VaultFileEntry[] = [
      ...[...this.folders.values()]
        .filter((folder) => folder.path !== "")
        .map((folder) => ({ path: folder.path, isFolder: true, mtime: 0, ctime: 0, size: 0 })),
      ...[...this.files.values()].map((file) => ({
        path: file.path,
        isFolder: false,
        mtime: file.mtime,
        ctime: file.ctime,
        size: file.size,
      })),
    ];
    return buildVaultManifest(this.root, entries);
  }

  async reconcile(): Promise<{
    status: "complete" | "partial" | "cancelled" | "unavailable";
    changes: ReconcileChange[];
    manifest?: VaultManifest;
    errorCode?: string;
  }> {
    const stored = await this.host.config.read(this.reconcileManifestKey());
    const previous = this.isValidManifest(stored)
      ? stored
      : this.currentManifest();
    const scan = await this.host.vaultFiles.reconcileScan();
    if (scan.status !== "complete") {
      return { status: scan.status, changes: [], errorCode: scan.errorCode };
    }
    const manifest = buildVaultManifest(this.root, scan.entries);
    const result = { status: "complete" as const, changes: diffVaultManifests(previous, manifest), manifest };
    const changes = result.changes.filter((change) => {
      if (!this.acknowledgedPathsSinceManifest.has(change.path)) return true;
      const known = this.getAbstractFileByPath(change.path);
      if (change.event === "create" || change.event === "create-folder") {
        if (known === null) return true;
        return (change.event === "create-folder") !== (known.kind === "folder");
      }
      if (change.event === "delete" || change.event === "delete-folder") return known !== null;
      if (change.event !== "modify") return false;
      return !known || known.kind !== "file" || known.mtime !== change.entry.mtime || known.size !== change.entry.size;
    });
    return { status: result.status, changes, manifest };
  }

  async commitReconcileManifest(manifest: VaultManifest): Promise<void> {
    if (manifest.vaultId !== this.root) throw new Error("Cannot commit a manifest for a different vault");
    await this.host.config.write(this.reconcileManifestKey(), manifest);
    this.hasDurableReconcileBaseline = true;
    this.acknowledgedPathsSinceManifest.clear();
  }

  /** Apply one already-durable reconciliation decision to the live model. */
  applyReconcileChange(change: ReconcileChange, content?: string): void {
    if (change.event === "create" || change.event === "create-folder") {
      if (this.getAbstractFileByPath(change.path)) return;
      this.indexEntry(change.entry);
      if (content !== undefined) this.contents.set(change.path, content);
      this.rebuildChildren();
      this.trigger("create", this.getAbstractFileByPath(change.path));
      return;
    }
    if (change.event === "modify") {
      const file = this.files.get(change.path);
      if (!file) {
        this.indexEntry(change.entry);
        this.rebuildChildren();
        this.trigger("create", this.files.get(change.path));
        return;
      }
      file.mtime = change.entry.mtime;
      file.ctime = change.entry.ctime;
      file.size = change.entry.size;
      if (content === undefined) this.contents.delete(change.path);
      else this.contents.set(change.path, content);
      this.trigger("modify", file);
      return;
    }
    if (change.event === "delete") {
      const file = this.files.get(change.path);
      if (!file) return;
      this.files.delete(change.path);
      this.contents.delete(change.path);
      this.rebuildChildren();
      this.trigger("delete", file);
      return;
    }
    const folder = this.folders.get(change.path);
    if (!folder) return;
    this.folders.delete(change.path);
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`${change.path}/`)) {
        this.files.delete(path);
        this.contents.delete(path);
      }
    }
    for (const path of [...this.folders.keys()]) {
      if (path.startsWith(`${change.path}/`)) this.folders.delete(path);
    }
    this.rebuildChildren();
    this.trigger("delete", folder);
  }

  dispose(): void {
    void this.close();
  }

  async close(): Promise<void> {
    this.stopHostChanges?.();
    this.stopHostChanges = null;
    this.ownMutationIds.clear();
    this.pendingHostEvents = [];
    await this.host.vaultRegistry.closeVault();
  }

  private async withHostMutation<T>(operation: (mutationId: string) => Promise<T>): Promise<T> {
    const id = `vault-${++this.mutationSequence}`;
    this.ownMutationIds.add(id);
    try {
      const result = await operation(id);
      await this.host.vaultFiles.settleMutation(id);
      return result;
    } finally {
      this.ownMutationIds.delete(id);
    }
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
  private _adapter?: DataAdapter;
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
  get adapter(): DataAdapter {
    if (!this._adapter || this._adapterRoot !== this.root) {
      const options = {
        getName: () => this.name,
        exists: (p: string) => this.host.vaultFiles.exists(p),
      };
      this._adapter = this.host.capabilities.nodePlugins
        ? new FileSystemAdapter(this.root, options)
        : new DataAdapter(options);
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
    const data = await this.host.vaultFiles.read(file.path);
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
    const data = await this.host.vaultFiles.read(file.path);
    this.contents.set(file.path, data);
    return data;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.host.vaultFiles.readBinary(file.path);
  }

  async create(path: string, data: string, options?: DataWriteOptions): Promise<TFile> {
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
    const { mtime, ctime, size } = await this.withHostMutation((id) =>
      this.host.vaultFiles.write(path, data, options, id)
    );
    this.indexEntry({ path, isFolder: false, mtime, ctime, size });
    this.acknowledgedPathsSinceManifest.add(path);
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
    await this.withHostMutation((id) => this.host.vaultFiles.mkdir(path, id));
    this.indexEntry({ path, isFolder: true, mtime: Date.now(), ctime: Date.now(), size: 0 });
    this.acknowledgedPathsSinceManifest.add(path);
    this.rebuildChildren();
    const folder = this.folders.get(path)!;
    this.trigger("create", folder);
    return folder;
  }

  async modify(file: TFile, data: string, options?: DataWriteOptions): Promise<void> {
    const { mtime, size } = await this.withHostMutation((id) =>
      this.host.vaultFiles.write(file.path, data, options, id)
    );
    file.mtime = mtime;
    file.size = size;
    this.acknowledgedPathsSinceManifest.add(file.path);
    this.contents.set(file.path, data);
    this.trigger("modify", file);
  }

  async trash(item: TFile | TFolder): Promise<void> {
    await this.withHostMutation((id) => this.host.vaultFiles.trash(item.path, id));
    this.acknowledgedPathsSinceManifest.add(item.path);
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
    await this.withHostMutation((id) => this.host.vaultFiles.rename(oldPath, newPath, id));
    this.acknowledgedPathsSinceManifest.add(oldPath);
    this.acknowledgedPathsSinceManifest.add(newPath);
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
