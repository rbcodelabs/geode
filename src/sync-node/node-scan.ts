import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SyncVaultEntry, SyncVaultPathIssue, SyncVaultScan } from "../sync-core/ports";

/**
 * Vault scanner for the headless host.
 *
 * Contract with the engine (see SyncVaultScan in sync-core/ports.ts):
 *  - `status: "complete"` is a promise that every directory was read, because the
 *    engine infers "the user deleted it" from absence. Any directory that cannot
 *    be listed (other than one that vanished with ENOENT) makes the scan
 *    `"partial"`, and the engine then refuses to plan at all.
 *  - Anything that exists but cannot be treated as ordinary content is reported
 *    in `blocked`, never silently dropped: iCloud placeholders and evicted files,
 *    files still being written, symlinks, unsupported file types. The engine
 *    treats a blocked path (and its descendants) as untouchable, so a blocked file
 *    is never read as absent and therefore never deleted remotely.
 *  - Deliberately unsynced items go in `excluded` (--exclude folders, iCloud
 *    conflict copies).
 * Dot-prefixed names are skipped (the engine's scope ignores them as well), which
 * keeps `.geode/`, `.git`, `.obsidian`, `.trash` and the `.geode-sync-tmp` staging
 * directory out of the walk entirely. The one dotted shape that matters is the
 * legacy iCloud placeholder `.<name>.icloud`.
 */

export const ICLOUD_NOT_DOWNLOADED = "icloud-not-downloaded";
export const ICLOUD_EVICTED = "icloud-evicted";
export const UNSETTLED = "unsettled";
export const ICLOUD_CONFLICT_COPY = "icloud-conflict-copy";

export interface ScanDirent { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; }
export interface ScanStat { size: number; mtimeMs: number; blocks: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; }
export interface ScanIo {
  opendir(dir: string): AsyncIterable<ScanDirent> | Promise<AsyncIterable<ScanDirent>>;
  lstat(file: string): Promise<ScanStat>;
}
export const defaultScanIo: ScanIo = { opendir: dir => fs.opendir(dir), lstat: file => fs.lstat(file) };

export interface ScanOptions {
  root: string;
  /** Vault-relative folders that are not synchronised (and not even walked). */
  excludeFolders?: readonly string[];
  /** Files modified more recently than this are deferred as `unsettled`. 0 disables. Default 5000. */
  settleMs?: number;
  /** Max concurrent directory reads / stats. Default 16. */
  concurrency?: number;
  /** Detect evicted-but-named files by `blocks === 0 && size > 0`. Default: on for darwin. */
  detectEvicted?: boolean;
  io?: ScanIo;
  now?: () => number;
  signal?: AbortSignal;
}

export interface ScanReport extends SyncVaultScan {
  /** Directories that could not be listed (why the scan is partial). */
  failures: Array<{ path: string; code: string }>;
}

const STUB = /^\.(.+)\.icloud$/;
/**
 * iCloud (and most sync tools) resolve a same-name collision by suffixing a number
 * before the extension: `Note.md` -> `Note 2.md`. Deliberately conservative: it is
 * a conflict copy ONLY when an extension is present, N is 2..99, AND the un-suffixed
 * sibling `<stem>.<ext>` exists in the same folder. A lone "Chapter 2.md", or
 * "Top 10.md" without a "Top.md" beside it, is ordinary content. The residual false
 * positive (an author who really keeps both "Top.md" and "Top 10.md") only costs a
 * visible `excluded` row, never data.
 */
const CONFLICT_COPY = /^(.+) ([2-9]|[1-9][0-9])(\.[^./]+)$/;

/** The sibling name a conflict copy shadows, or null when `name` is not shaped like one. */
export function conflictCopyBase(name: string): string | null {
  const match = CONFLICT_COPY.exec(name);
  return match ? match[1] + match[3] : null;
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

class Gate {
  private active = 0; private waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.active++;
    try { return await fn(); } finally { this.active--; this.waiting.shift()?.(); }
  }
}

export async function scanVault(options: ScanOptions): Promise<ScanReport> {
  const io = options.io ?? defaultScanIo, now = options.now ?? Date.now;
  const settleMs = options.settleMs ?? 5000, gate = new Gate(Math.max(1, options.concurrency ?? 16));
  const detectEvicted = options.detectEvicted ?? process.platform === "darwin";
  const excludeFolders = new Set((options.excludeFolders ?? []).map(folder => folder.replace(/^\/+|\/+$/g, "")).filter(Boolean));
  const entries: SyncVaultEntry[] = [], blocked: SyncVaultPathIssue[] = [], excluded: SyncVaultPathIssue[] = [], failures: Array<{ path: string; code: string }> = [];
  const started = now();
  let cancelled = false;

  const statFile = async (rel: string, conflictBase: string | null, siblings: ReadonlySet<string>) => {
    if (conflictBase !== null && siblings.has(conflictBase)) { excluded.push({ path: rel, reason: ICLOUD_CONFLICT_COPY }); return; }
    let stat: ScanStat;
    try { stat = await gate.run(() => io.lstat(path.join(options.root, rel))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // vanished between listing and stat: truly gone
      blocked.push({ path: rel, reason: `stat-failed:${(error as NodeJS.ErrnoException).code ?? "unknown"}` }); return;
    }
    if (stat.isSymbolicLink()) { blocked.push({ path: rel, reason: "symlink" }); return; }
    if (!stat.isFile()) { blocked.push({ path: rel, reason: "unsupported-file-type" }); return; }
    if (detectEvicted && stat.blocks === 0 && stat.size > 0) { blocked.push({ path: rel, reason: ICLOUD_EVICTED }); return; }
    // A future mtime (clock skew) is also "unsettled": its age is unknowable, so it is never trusted.
    if (settleMs > 0 && started - stat.mtimeMs < settleMs) { blocked.push({ path: rel, reason: UNSETTLED }); return; }
    entries.push({ path: rel, isFolder: false, mtime: Math.floor(stat.mtimeMs), size: stat.size });
  };

  const walk = async (dir: string): Promise<void> => {
    if (options.signal?.aborted) { cancelled = true; return; }
    const children: ScanDirent[] = [];
    try {
      const handle = await gate.run(async () => await io.opendir(path.join(options.root, dir)));
      for await (const dirent of handle) children.push(dirent);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      if (code !== "ENOENT") failures.push({ path: dir || ".", code }); // ENOENT: the directory vanished, its contents are genuinely gone
      return;
    }
    // Logical names present in this folder (placeholders count under their real name).
    const siblings = new Set<string>(), stubs = new Map<string, string>();
    for (const child of children) {
      const stub = child.isFile() ? STUB.exec(child.name) : null;
      if (stub) stubs.set(stub[1], child.name); else siblings.add(child.name);
    }
    // A placeholder stands in for its real name when deciding whether a numbered sibling is a conflict copy.
    const logical = new Set<string>([...siblings, ...stubs.keys()]);
    const work: Array<Promise<unknown>> = [], subdirs: string[] = [];
    for (const [logical] of stubs) if (!siblings.has(logical)) blocked.push({ path: join(dir, logical), reason: ICLOUD_NOT_DOWNLOADED });
    for (const child of children) {
      const name = child.name;
      if (name.startsWith(".")) continue;
      const rel = join(dir, name);
      if (child.isSymbolicLink()) { blocked.push({ path: rel, reason: "symlink" }); continue; }
      if (child.isDirectory()) {
        if (excludeFolders.has(rel)) { excluded.push({ path: rel, reason: "excluded-folder" }); continue; }
        entries.push({ path: rel, isFolder: true, mtime: 0, size: 0 });
        subdirs.push(rel); continue;
      }
      if (child.isFile()) { work.push(statFile(rel, conflictCopyBase(name), logical)); continue; }
      blocked.push({ path: rel, reason: "unsupported-file-type" });
    }
    await Promise.all([...work, ...subdirs.map(walk)]);
  };

  await walk("");
  const status: SyncVaultScan["status"] = cancelled ? "cancelled" : failures.length ? "partial" : "complete";
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { status, entries: entries.sort(byPath), blocked: blocked.sort(byPath), excluded: excluded.sort(byPath), failures };
}
