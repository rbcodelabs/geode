import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { withPathLock } from "./path-lock";
import { ensureDurableDirectory } from "./sync-apply";

/** Private device storage: frozen bytes and one bounded journal per operation. */
export class SyncPrivateStorage {
  constructor(private readonly root: string, private readonly availableBytes: () => Promise<number> = async () => { const stat = await fs.statfs(root); return stat.bavail * stat.bsize; }) {}
  private file(key: string, suffix: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key)) throw new Error("Invalid sync operation identity");
    return path.join(this.root, key + suffix);
  }
  private async write(target: string, bytes: Uint8Array): Promise<void> {
    await ensureDurableDirectory(this.root);
    const temporary = target + "." + randomUUID() + ".tmp";
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, target);
    const directory = await fs.open(this.root, "r"); try { await directory.sync(); } finally { await directory.close(); }
  }
  async stage(key: string, bytes: ArrayBuffer): Promise<string> {
    if (bytes.byteLength > 100 * 1024 * 1024) throw new Error("Sync file exceeds 100 MiB limit");
    const target = this.file(key, ".blob");
    await withPathLock([target], async () => {
      const prior = await fs.readFile(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (prior) { if (!prior.equals(Buffer.from(bytes))) throw new Error("Frozen sync bytes differ from retry content"); return; }
      await ensureDurableDirectory(this.root);
      if (await this.availableBytes() < bytes.byteLength * 2 + 4 * 1024 * 1024) throw new Error("Insufficient disk space for frozen sync bytes and recovery headroom");
      await this.write(target, new Uint8Array(bytes));
    });
    return key;
  }
  async readStage(key: string): Promise<ArrayBuffer> {
    const target = this.file(key, ".blob");
    if ((await fs.stat(target)).size > 100 * 1024 * 1024) throw new Error("Sync file exceeds 100 MiB limit");
    const bytes = await fs.readFile(target); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  async saveOperation(key: string, value: unknown): Promise<void> {
    const target = this.file(key, ".json"); const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 1024 * 1024) throw new Error("Sync operation metadata exceeds limit");
    await withPathLock([target], () => this.write(target, bytes));
  }
  async loadOperations(): Promise<unknown[]> {
    const names = await fs.readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const values: unknown[] = [];
    for (const name of names.sort()) if (name.endsWith(".json")) values.push(JSON.parse(await fs.readFile(this.file(name.slice(0, -5), ".json"), "utf8")));
    return values;
  }
  /** Deletes the blob and journal for one operation. Idempotent; callers must only release once the operation is terminal and the controller state naming it is durable. */
  async release(key: string): Promise<void> {
    const targets = [this.file(key, ".blob"), this.file(key, ".json")];
    await withPathLock(targets, async () => {
      for (const target of targets) await fs.rm(target, { force: true });
    });
  }
  /**
   * Startup garbage collection for one binding directory. Keeps only what crash
   * recovery can still need: journals and blobs of 'prepared' operations, plus
   * anything in `retain` (the ids of a durable pendingBatch, whose committed
   * journals recovery still looks up). Unparseable journals are left alone.
   */
  async gc(retain: readonly string[] = []): Promise<{ removed: number }> {
    const names = await fs.readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const keep = new Set(retain); const journals: string[] = [];
    for (const name of names) if (name.endsWith(".json")) {
      try {
        const value = JSON.parse(await fs.readFile(path.join(this.root, name), "utf8")) as { phase?: unknown; payload?: { key?: unknown } };
        if (value?.phase === "prepared") { keep.add(name.slice(0, -5)); if (typeof value.payload?.key === "string") keep.add(value.payload.key); }
        journals.push(name);
      } catch { keep.add(name.slice(0, -5)); }
    }
    let removed = 0;
    for (const name of names) {
      const full = path.join(this.root, name);
      if (name.endsWith(".tmp")) { await fs.rm(full, { force: true }); removed++; continue; }
      const match = /^(.+)\.(blob|json)$/.exec(name);
      if (!match || keep.has(match[1])) continue;
      await withPathLock([full], () => fs.rm(full, { force: true })); removed++;
    }
    return { removed };
  }
  /**
   * Removes binding directories of one vault. With `force`, every binding goes
   * (disconnect). Otherwise a directory not in `keep` is removed only when it
   * holds no 'prepared' journal, since its device state could still resume it.
   * `vaultRoot` is the sync-private/<rootHash> directory; it is never a path
   * derived from a request.
   */
  static async sweepBindings(vaultRoot: string, keep: readonly string[], force: boolean): Promise<{ removed: string[]; skipped: string[] }> {
    const entries = await fs.readdir(vaultRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const removed: string[] = []; const skipped: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name) || (!force && keep.includes(entry.name))) continue;
      const dir = path.join(vaultRoot, entry.name);
      if (!force) {
        const pending = (await fs.readdir(dir).catch(() => [])).filter(name => name.endsWith(".json"));
        let prepared = false;
        for (const name of pending) { try { if (JSON.parse(await fs.readFile(path.join(dir, name), "utf8"))?.phase === "prepared") prepared = true; } catch { prepared = true; } }
        if (prepared) { skipped.push(entry.name); continue; }
      }
      await fs.rm(dir, { recursive: true, force: true }); removed.push(entry.name);
    }
    if (force) await fs.rmdir(vaultRoot).catch(() => {});
    return { removed, skipped };
  }
}
