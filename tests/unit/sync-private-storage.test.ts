import { expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SyncPrivateStorage } from "../../src/main/sync-private-storage";

it("rejects a frozen transfer before writing when private storage lacks recovery headroom", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-capacity-"));
  try {
    const storage = new SyncPrivateStorage(root, async () => 0);
    await expect(storage.stage("12345678-1234-4234-8234-123456789012", new ArrayBuffer(1))).rejects.toThrow(/disk space/);
    expect(await fs.readdir(root)).toEqual([]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("persists frozen binary bytes separately and never replaces differing retry content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-private-"));
  try {
    const storage = new SyncPrivateStorage(root);
    const key = "12345678-1234-4234-8234-123456789012";
    await storage.stage(key, new Uint8Array([0, 255]).buffer);
    expect([...new Uint8Array(await new SyncPrivateStorage(root).readStage(key))]).toEqual([0, 255]);
    await expect(storage.stage(key, new Uint8Array([1]).buffer)).rejects.toThrow(/differ/);
    await storage.saveOperation(key, { operationId: key, phase: "prepared" });
    await storage.saveOperation(key, { operationId: key, phase: "published" });
    expect(await storage.loadOperations()).toEqual([{ operationId: key, phase: "published" }]);
    await expect(storage.readStage("../escape")).rejects.toThrow(/identity/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
