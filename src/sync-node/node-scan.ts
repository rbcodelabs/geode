import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_ROOTS, portableConfigCategory } from "../sync-core/scope";
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
 *  - Deliberately unsynced items go in `excluded` (--exclude folders).
 * Names are never judged by their shape: `Note 2.md` beside `Note.md` is an ordinary
 * file like any other.
 * Dot-prefixed names are skipped (the engine's scope ignores them as well), which
 * keeps `.git`, `.trash`, `.claude`, `.gitignore` and the `.geode-sync-tmp` staging
 * directory out of the walk entirely. The exceptions are the two configuration roots
 * `.geode/` and `.obsidian/`: the walk enters them, but descends only into
 * themes/, snippets/ and plugins/ and emits only files that scope.ts classifies as
 * portable configuration (portableConfigCategory); everything else in there
 * (workspace*.json, caches, `.geode/sync`, node_modules) is skipped without a trace,
 * like any other unsynced dot path. Whether a classified file actually syncs is then
 * the scope's call. The one other dotted shape that matters is the legacy iCloud
 * placeholder `.<name>.icloud`.
 */

export const ICLOUD_NOT_DOWNLOADED = "icloud-not-downloaded";
export const ICLOUD_EVICTED = "icloud-evicted";
export const UNSETTLED = "unsettled";

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

  const statFile = async (rel: string) => {
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
    // Placeholders stand in for their real name: a stub with no real file beside it is a blocked (not downloaded) file.
    const siblings = new Set<string>(), stubs = new Map<string, string>();
    for (const child of children) {
      const stub = child.isFile() ? STUB.exec(child.name) : null;
      if (stub) stubs.set(stub[1], child.name); else siblings.add(child.name);
    }
    const work: Array<Promise<unknown>> = [], subdirs: string[] = [];
    // Inside a configuration root only the allowlisted shapes are walked; at the vault root only the two roots.
    const inConfig = CONFIG_ROOTS.includes(dir.split("/")[0]);
    for (const [logical] of stubs) {
      const rel = join(dir, logical);
      if (!siblings.has(logical) && (!inConfig || portableConfigCategory(rel) !== null)) blocked.push({ path: rel, reason: ICLOUD_NOT_DOWNLOADED });
    }
    for (const child of children) {
      const name = child.name;
      const rel = join(dir, name);
      if (name.startsWith(".")) {
        // The two config roots are real directories (a symlinked root stays unsynced and silent, as every dot path was).
        if (!(dir === "" && child.isDirectory() && !child.isSymbolicLink() && CONFIG_ROOTS.includes(name) && !excludeFolders.has(name))) continue;
        subdirs.push(rel); continue; // the root itself is not an entry: it is not content
      }
      // A directory in a config root is entered only if something beneath it could be portable (so not workspaces/, node_modules/, cache/).
      if (inConfig && child.isDirectory() && portableConfigCategory(`${rel}/x`) === null) continue;
      if (inConfig && (child.isFile() || child.isSymbolicLink()) && portableConfigCategory(rel) === null && (!child.isSymbolicLink() || portableConfigCategory(`${rel}/x`) === null)) continue;
      if (child.isSymbolicLink()) { blocked.push({ path: rel, reason: "symlink" }); continue; }
      if (child.isDirectory()) {
        if (excludeFolders.has(rel)) { excluded.push({ path: rel, reason: "excluded-folder" }); continue; }
        entries.push({ path: rel, isFolder: true, mtime: 0, size: 0 });
        subdirs.push(rel); continue;
      }
      if (child.isFile()) { work.push(statFile(rel)); continue; }
      blocked.push({ path: rel, reason: "unsupported-file-type" });
    }
    await Promise.all([...work, ...subdirs.map(walk)]);
  };

  await walk("");
  const status: SyncVaultScan["status"] = cancelled ? "cancelled" : failures.length ? "partial" : "complete";
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { status, entries: entries.sort(byPath), blocked: blocked.sort(byPath), excluded: excluded.sort(byPath), failures };
}
