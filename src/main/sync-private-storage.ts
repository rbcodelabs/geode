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
}
