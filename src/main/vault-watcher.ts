import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import chokidar from "chokidar";
import { isIgnoredVaultPath } from "./vault-ignore";

/**
 * Vault file watching.
 *
 * ## Why this is not chokidar
 *
 * chokidar v4 dropped its `fsevents` backend, so it now calls Node's
 * `fs.watch()` once per path. On macOS libuv only uses FSEvents for
 * *directories*; for an individual file it falls back to kqueue, which needs
 * `open(path, O_RDONLY)` and holds that descriptor for the life of the watch.
 * That is one open file descriptor per vault file. Past ~10,240 (the macOS
 * default `RLIMIT_NOFILE`) the process cannot allocate the descriptor
 * Chromium needs for the seatbelt sandbox handshake, and every sandboxed
 * renderer — i.e. every `<webview>` in the Web Viewer — aborts on launch
 * with an unactionable "exit code 6".
 *
 * A single native *recursive* `fs.watch(root, { recursive: true })` is
 * FSEvents-backed on macOS and costs zero extra descriptors regardless of
 * vault size (measured: 0 delta on an 11,082-file vault).
 *
 * ## The cost of that
 *
 * A recursive watch reports only `"rename"` / `"change"` plus a path. The app
 * consumes five distinct events, so this module reconstructs them by keeping
 * a mirror of known paths and stat-ing each changed path against it.
 *
 * ## Rules the synthesis must respect (from the consumers)
 *
 * - Never emit `modify` for a path the renderer does not already know:
 *   `src/renderer/vault.ts` drops it and the file never enters the tree.
 *   `create` for a known path is a documented no-op there, so bias to
 *   `create`.
 * - Over-emission is safe, under-emission is not. The renderer's handlers
 *   are explicitly idempotent against duplicate and delayed echoes (see
 *   `src/renderer/app.ts` and `src/renderer/views/base-view.ts`).
 * - Folder deletes must cascade. `src/renderer/vault.ts` does not remove
 *   descendants itself; that only worked before because chokidar emitted a
 *   separate event per descendant. The mirror makes it deterministic.
 */

export type VaultWatchEventName =
  | "create"
  | "modify"
  | "delete"
  | "create-folder"
  | "delete-folder";

export type VaultWatchBackend = "native-recursive" | "chokidar";

export interface VaultWatchEmission {
  event: VaultWatchEventName;
  path: string;
}

/** What a `stat` of a changed path found. */
export type VaultPathKind = "file" | "folder" | "missing" | "other";

export interface VaultWatcherSeedEntry {
  path: string;
  isFolder: boolean;
}

/**
 * `fs.watch` fires while a write is still in flight. chokidar's
 * `awaitWriteFinish` used to absorb that; without an equivalent the indexer
 * would `readFile` half-written notes (truncated Markdown, `.canvas` JSON
 * parse errors). Same 300 ms window chokidar was configured with.
 */
export const DEFAULT_STABILITY_THRESHOLD_MS = 300;

/** Mirror of the vault paths the renderer is believed to know about. */
export class VaultPathMirror {
  private readonly files = new Set<string>();
  private readonly folders = new Set<string>();

  constructor(seed: Iterable<VaultWatcherSeedEntry> = []) {
    for (const entry of seed) {
      if (entry.isFolder) this.folders.add(entry.path);
      else this.files.add(entry.path);
    }
  }

  hasFile(relativePath: string): boolean { return this.files.has(relativePath); }
  hasFolder(relativePath: string): boolean { return this.folders.has(relativePath); }
  addFile(relativePath: string): void { this.files.add(relativePath); }
  addFolder(relativePath: string): void { this.folders.add(relativePath); }
  removeFile(relativePath: string): void { this.files.delete(relativePath); }
  removeFolder(relativePath: string): void { this.folders.delete(relativePath); }
  get size(): number { return this.files.size + this.folders.size; }

  /**
   * Known descendants of a folder, deepest first so a caller emitting them in
   * order removes leaves before their parents.
   */
  descendantsOf(folderPath: string): { files: string[]; folders: string[] } {
    const prefix = `${folderPath}/`;
    const byDepthDesc = (a: string, b: string) => depthOf(b) - depthOf(a) || a.localeCompare(b);
    return {
      files: [...this.files].filter((p) => p.startsWith(prefix)).sort(byDepthDesc),
      folders: [...this.folders].filter((p) => p.startsWith(prefix)).sort(byDepthDesc),
    };
  }
}

function depthOf(relativePath: string): number {
  let depth = 0;
  for (const character of relativePath) if (character === "/") depth += 1;
  return depth;
}

/** Ancestor folders of a path, shallowest first: `a/b/c.md` -> `a`, `a/b`. */
function ancestorsOf(relativePath: string): string[] {
  const segments = relativePath.split("/");
  segments.pop();
  const ancestors: string[] = [];
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    ancestors.push(current);
  }
  return ancestors;
}

/**
 * Turn "path X is now `kind`" into the events the app expects, updating the
 * mirror as it goes.
 *
 * | stat        | mirror        | emit                                              |
 * |-------------|---------------|---------------------------------------------------|
 * | file        | unknown       | `create`                                          |
 * | file        | known file    | `modify`                                          |
 * | folder      | unknown       | `create-folder`                                   |
 * | folder      | known folder  | nothing                                           |
 * | missing     | known file    | `delete`                                          |
 * | missing     | known folder  | descendants, then `delete-folder`                 |
 * | missing     | unknown       | nothing                                           |
 *
 * Unknown ancestors are announced as `create-folder` first, so a folder event
 * lost to FSEvents coalescing cannot strand a file outside the tree.
 */
export function synthesizeVaultEvents(
  mirror: VaultPathMirror,
  relativePath: string,
  kind: VaultPathKind,
): VaultWatchEmission[] {
  if (!relativePath || isIgnoredVaultPath(relativePath)) return [];
  const emissions: VaultWatchEmission[] = [];

  if (kind === "missing") {
    if (mirror.hasFile(relativePath)) {
      mirror.removeFile(relativePath);
      emissions.push({ event: "delete", path: relativePath });
    }
    if (mirror.hasFolder(relativePath)) {
      emissions.push(...removeFolderTree(mirror, relativePath));
    }
    return emissions;
  }

  if (kind === "other") return [];

  for (const ancestor of ancestorsOf(relativePath)) {
    if (mirror.hasFolder(ancestor)) continue;
    mirror.addFolder(ancestor);
    emissions.push({ event: "create-folder", path: ancestor });
  }

  if (kind === "file") {
    // A path that used to be a folder and is now a file: tear the old subtree
    // down before announcing the file, so the renderer never holds both.
    if (mirror.hasFolder(relativePath)) emissions.push(...removeFolderTree(mirror, relativePath));
    if (mirror.hasFile(relativePath)) {
      emissions.push({ event: "modify", path: relativePath });
    } else {
      mirror.addFile(relativePath);
      emissions.push({ event: "create", path: relativePath });
    }
    return emissions;
  }

  // kind === "folder"
  if (mirror.hasFile(relativePath)) {
    mirror.removeFile(relativePath);
    emissions.push({ event: "delete", path: relativePath });
  }
  if (!mirror.hasFolder(relativePath)) {
    mirror.addFolder(relativePath);
    emissions.push({ event: "create-folder", path: relativePath });
  }
  return emissions;
}

/** Descendants first (deepest first), then the folder itself. */
function removeFolderTree(mirror: VaultPathMirror, folderPath: string): VaultWatchEmission[] {
  const emissions: VaultWatchEmission[] = [];
  const { files, folders } = mirror.descendantsOf(folderPath);
  for (const file of files) {
    mirror.removeFile(file);
    emissions.push({ event: "delete", path: file });
  }
  for (const folder of folders) {
    mirror.removeFolder(folder);
    emissions.push({ event: "delete-folder", path: folder });
  }
  mirror.removeFolder(folderPath);
  emissions.push({ event: "delete-folder", path: folderPath });
  return emissions;
}

/**
 * Normalize a watcher-supplied path to the vault's `/`-separated form.
 *
 * Only `path.sep` is translated: on POSIX a backslash is a legal filename
 * character, so rewriting it would corrupt real paths.
 */
export function toVaultRelative(rawPath: string): string {
  const normalized = path.sep === "/" ? rawPath : rawPath.split(path.sep).join("/");
  return normalized.replace(/^\/+|\/+$/g, "");
}

export interface VaultWatcherLogger {
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

export interface VaultWatcherDependencies {
  /** Start one recursive watch. Must throw when the platform cannot do it. */
  watchRecursive(root: string, onEvent: (relativePath: string | null) => void, onError: (error: unknown) => void): { close(): void };
  statPath(absolutePath: string): Promise<VaultPathKind>;
  readFolder(absolutePath: string): Promise<Array<{ name: string; kind: VaultPathKind }>>;
  startFallback(root: string, stabilityThresholdMs: number, emit: (event: VaultWatchEventName, relativePath: string) => void): { close(): Promise<void> | void };
  logger: VaultWatcherLogger;
}

export interface VaultWatcherOptions {
  root: string;
  /** Usually the `listVaultFiles()` result the caller already computed. */
  seed: Iterable<VaultWatcherSeedEntry>;
  emit(event: VaultWatchEventName, relativePath: string): void;
  stabilityThresholdMs?: number;
  dependencies?: Partial<VaultWatcherDependencies>;
}

export interface VaultWatcherHandle {
  /** Which implementation actually ended up running. */
  readonly backend: VaultWatchBackend;
  close(): Promise<void>;
  /** Test seam: resolves once every pending debounce has been processed. */
  readonly idle: () => Promise<void>;
}

const defaultDependencies: VaultWatcherDependencies = {
  watchRecursive(root, onEvent, onError) {
    const watcher = fs.watch(root, { recursive: true, persistent: true }, (_eventType, filename) => {
      onEvent(filename === null || filename === undefined ? null : filename.toString());
    });
    watcher.on("error", onError);
    return { close: () => watcher.close() };
  },
  async statPath(absolutePath) {
    const stats = await fsp.stat(absolutePath).catch(() => null);
    if (!stats) return "missing";
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "folder";
    return "other";
  },
  async readFolder(absolutePath) {
    const entries = await fsp.readdir(absolutePath, { withFileTypes: true }).catch(() => []);
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "folder" : entry.isFile() ? "file" : "other",
    }));
  },
  startFallback(root, stabilityThresholdMs, emit) {
    const watcher = chokidar.watch(root, {
      ignored: (candidate) => isIgnoredVaultPath(path.relative(root, candidate)),
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: stabilityThresholdMs, pollInterval: 100 },
    });
    const forward = (event: VaultWatchEventName) => (absolutePath: string) =>
      emit(event, toVaultRelative(path.relative(root, absolutePath)));
    watcher
      .on("add", forward("create"))
      .on("change", forward("modify"))
      .on("unlink", forward("delete"))
      .on("addDir", forward("create-folder"))
      .on("unlinkDir", forward("delete-folder"));
    return { close: () => watcher.close() };
  },
  logger: console,
};

/**
 * Watch a vault and emit `create` / `modify` / `delete` / `create-folder` /
 * `delete-folder` for changes made outside the app.
 *
 * Falls back to chokidar when a recursive watch is unavailable (older
 * platforms, network filesystems) or fails at runtime, so nothing regresses
 * off macOS.
 */
export function startVaultWatcher(options: VaultWatcherOptions): VaultWatcherHandle {
  const dependencies: VaultWatcherDependencies = { ...defaultDependencies, ...options.dependencies };
  const stabilityThresholdMs = options.stabilityThresholdMs ?? DEFAULT_STABILITY_THRESHOLD_MS;
  const root = options.root;
  const mirror = new VaultPathMirror(options.seed);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  let backend: VaultWatchBackend = "native-recursive";
  let close: () => Promise<void> | void = () => {};

  const emit = (event: VaultWatchEventName, relativePath: string) => {
    if (closed) return;
    options.emit(event, relativePath);
  };

  /**
   * Announce a newly discovered subtree. FSEvents can coalesce a moved-in
   * directory into a single event for the directory, so its contents have to
   * be discovered by hand. Only *unknown* paths are announced, and recursion
   * only follows folders that were themselves unknown, which bounds the walk
   * to genuinely new content instead of re-announcing the whole vault.
   */
  const announceNewSubtree = async (folderPath: string): Promise<void> => {
    if (closed) return;
    const entries = await dependencies.readFolder(path.join(root, ...folderPath.split("/")));
    for (const entry of entries) {
      const childPath = folderPath ? `${folderPath}/${entry.name}` : entry.name;
      if (isIgnoredVaultPath(childPath)) continue;
      if (entry.kind === "folder") {
        if (mirror.hasFolder(childPath)) continue;
        mirror.addFolder(childPath);
        emit("create-folder", childPath);
        await announceNewSubtree(childPath);
      } else if (entry.kind === "file") {
        if (mirror.hasFile(childPath)) continue;
        mirror.addFile(childPath);
        emit("create", childPath);
      }
    }
  };

  const flush = async (relativePath: string): Promise<void> => {
    if (closed) return;
    const kind = await dependencies.statPath(path.join(root, ...relativePath.split("/")));
    const emissions = synthesizeVaultEvents(mirror, relativePath, kind);
    for (const emission of emissions) emit(emission.event, emission.path);
    for (const emission of emissions) {
      if (emission.event === "create-folder") await announceNewSubtree(emission.path);
    }
  };

  const schedule = (relativePath: string) => {
    const pending = timers.get(relativePath);
    if (pending) clearTimeout(pending);
    timers.set(relativePath, setTimeout(() => {
      timers.delete(relativePath);
      const task = flush(relativePath)
        .catch((error) => dependencies.logger.error("Vault watcher failed to process a change", error))
        .finally(() => { inFlight.delete(task); });
      inFlight.add(task);
    }, stabilityThresholdMs));
  };

  const onEvent = (rawPath: string | null) => {
    if (closed) return;
    if (rawPath === null) {
      // The OS dropped events (queue overflow). There is no path to
      // reconcile, and a full rescan on every overflow would be worse than
      // the miss; the next real event re-syncs the affected path.
      dependencies.logger.warn("Vault watcher received an event with no path; some changes may be missed");
      return;
    }
    const relativePath = toVaultRelative(rawPath);
    if (!relativePath || isIgnoredVaultPath(relativePath)) return;
    schedule(relativePath);
  };

  const activateFallback = (reason: unknown) => {
    if (closed || backend === "chokidar") return;
    dependencies.logger.warn(
      "Recursive vault watch unavailable; falling back to chokidar (one file descriptor per file)",
      reason,
    );
    backend = "chokidar";
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    const fallback = dependencies.startFallback(root, stabilityThresholdMs, emit);
    close = () => fallback.close();
  };

  try {
    const watcher = dependencies.watchRecursive(root, onEvent, (error) => {
      // A recursive watch that dies at runtime (inotify limits, an unmounted
      // volume) leaves the vault silently unwatched. Take the descriptor cost
      // over losing live updates entirely.
      const previousClose = close;
      void Promise.resolve(previousClose()).catch(() => {});
      close = () => {};
      activateFallback(error);
    });
    close = () => watcher.close();
  } catch (error) {
    activateFallback(error);
  }

  return {
    get backend() { return backend; },
    idle: async () => { while (inFlight.size) await Promise.all([...inFlight]); },
    close: async () => {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.resolve(close()).catch(() => {});
      await Promise.allSettled([...inFlight]);
    },
  };
}
