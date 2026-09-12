import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createWikiSnapshot, DEFAULT_SNAPSHOT_LIMITS, normalizeWikiPath, type CapturedFile, type Diagnostic, type SnapshotLimits, type WikiSnapshot } from "./snapshot";

export interface WikiReadHandle {
  stat(): Promise<Stats>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
/** Narrow adapter seam for deterministic failure tests; never passed to snapshot queries. */
export interface WikiFileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
  entries(path: string): AsyncIterable<string>;
  open(path: string): Promise<WikiReadHandle>;
}
export const nodeWikiFileSystem: WikiFileSystem = {
  realpath, lstat,
  async *entries(path) {
    const directory = await opendir(path);
    // Node's async iterator closes the directory on return/throw, including early cap exits.
    for await (const entry of directory) yield entry.name;
  },
  // NONBLOCK avoids blocking on a FIFO substituted after lstat. fstat still requires a regular file.
  open: path => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)),
};
export interface OpenSnapshotOptions { limits?: Partial<SnapshotLimits>; filesystem?: WikiFileSystem }
export type OpenSnapshotResult = { status: "ok"; snapshot: WikiSnapshot } | {
  status: "error"; error: { code: "invalid-limits" | "root-unavailable" | "root-not-directory" };
};
class CaptureFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
const identity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats) => identity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep);
}

/** Read a trusted, user-selected local folder into memory; this is not a hostile-tree OS sandbox. */
export async function openLocalWikiSnapshot(rootPath: string, options: OpenSnapshotOptions = {}): Promise<OpenSnapshotResult> {
  const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...options.limits };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0)) return { status: "error", error: { code: "invalid-limits" } };
  const fs = options.filesystem ?? nodeWikiFileSystem;
  let root: string;
  let rootStat: Stats;
  try {
    root = await fs.realpath(resolve(rootPath));
    rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { status: "error", error: { code: "root-not-directory" } };
  } catch { return { status: "error", error: { code: "root-unavailable" } }; }

  const scanStartedAt = new Date().toISOString();
  const captured: CapturedFile[] = [];
  const diagnostics: Diagnostic[] = [];
  let discoveryComplete = true;
  let visited = 0;
  let reservedBytes = 0;
  let stopped = false;
  const report = (code: string, path: string, incomplete = false) => {
    diagnostics.push({ code, path });
    if (incomplete) discoveryComplete = false;
  };

  async function checkedComponents(path: string): Promise<Stats[]> {
    const components = path ? path.split("/") : [];
    let absolute = root;
    const stats = [await fs.lstat(root)];
    if (!stats[0].isDirectory() || stats[0].isSymbolicLink() || !identity(rootStat, stats[0])) throw new CaptureFailure("path-changed");
    for (let i = 0; i < components.length; i++) {
      absolute = join(absolute, components[i]);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || (i < components.length - 1 && !stat.isDirectory())) throw new CaptureFailure("path-changed");
      stats.push(stat);
    }
    if (!contained(root, await fs.realpath(absolute))) throw new CaptureFailure("path-changed");
    return stats;
  }

  async function readNote(path: string, observed: Stats): Promise<string> {
    const before = await checkedComponents(path);
    const last = before[before.length - 1];
    if (!last.isFile() || !unchanged(observed, last)) throw new CaptureFailure("file-changed");
    if (!Number.isSafeInteger(last.size) || last.size < 0 || last.size > limits.maxNoteBytes) throw new CaptureFailure("note-byte-limit");
    if (last.size > limits.maxTotalNoteBytes - reservedBytes) throw new CaptureFailure("total-byte-limit");
    // Reserve even failed reads to bound attempted data work, not only retained content.
    reservedBytes += last.size;
    const handle = await fs.open(join(root, path));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !unchanged(last, opened)) throw new CaptureFailure("file-changed");
      const afterOpen = await checkedComponents(path);
      if (afterOpen.some((stat, i) => !identity(stat, before[i]))) throw new CaptureFailure("path-changed");
      const bytes = new Uint8Array(last.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead <= 0) throw new CaptureFailure("file-changed");
        offset += bytesRead;
      }
      // One extra byte tests growth; it is never retained or parsed.
      if ((await handle.read(new Uint8Array(1), 0, 1, offset)).bytesRead !== 0) throw new CaptureFailure("file-changed");
      const afterRead = await handle.stat();
      const after = await checkedComponents(path);
      if (!unchanged(opened, afterRead) || !unchanged(afterRead, after[after.length - 1]) || after.some((stat, i) => !identity(stat, before[i]))) throw new CaptureFailure("file-changed");
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new CaptureFailure("invalid-utf8"); }
    } finally { await handle.close(); }
  }

  async function walk(directory: string, depth: number): Promise<void> {
    try {
      const before = await checkedComponents(directory);
      if (!before[before.length - 1].isDirectory()) throw new CaptureFailure("path-changed");
      for await (const name of fs.entries(join(root, directory))) {
        if (stopped) break;
        if (visited === limits.maxVisitedEntries) { report("visited-entry-limit", directory, true); stopped = true; break; }
        visited++;
        const path = directory ? directory + "/" + name : name;
        if (name.includes("/") || normalizeWikiPath(path) !== path) { report("invalid-entry-path", directory, true); continue; }
        if (name.startsWith(".")) continue;
        let stat: Stats;
        try { stat = await fs.lstat(join(root, path)); }
        catch { report("entry-stat-failed", path, true); continue; }
        if (stat.isSymbolicLink()) { report("symlink-excluded", path); continue; }
        if (stat.isDirectory()) {
          if (name === "node_modules") continue;
          if (depth + 1 >= limits.maxDepth) { report("depth-limit", path, true); continue; }
          await walk(path, depth + 1);
          if (stopped) break;
          continue;
        }
        if (!stat.isFile()) { report("special-file-excluded", path); continue; }
        if (captured.length === limits.maxEntries) { report("entry-limit", path, true); stopped = true; break; }
        const entry: CapturedFile = { path, kind: /\.md$/i.test(name) ? "note" : "attachment" };
        captured.push(entry);
        if (entry.kind === "note") {
          try { entry.text = await readNote(path, stat); }
          catch (error) { report(error instanceof CaptureFailure ? error.code : "file-read-failed", path); }
        }
      }
      const after = await checkedComponents(directory);
      if (after.some((stat, i) => !identity(stat, before[i]))) throw new CaptureFailure("path-changed");
    } catch (error) {
      if (!directory) throw error;
      report(error instanceof CaptureFailure ? error.code : "directory-read-failed", directory, true);
    }
  }
  try { await walk("", 0); }
  catch { return { status: "error", error: { code: "root-unavailable" } }; }
  return { status: "ok", snapshot: createWikiSnapshot(captured, {
    discoveryComplete, diagnostics, limits, scanStartedAt, scanEndedAt: new Date().toISOString(),
  }) };
}
