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

const K1 = "12345678-1234-4234-8234-123456789012", K2 = "22345678-1234-4234-8234-123456789012", K3 = "32345678-1234-4234-8234-123456789012";
const withRoot = async (run: (root: string) => Promise<void>) => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-gc-")); try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); } };

it("release deletes blob and journal, is idempotent, and validates the key", () => withRoot(async root => {
  const storage = new SyncPrivateStorage(root);
  await storage.stage(K1, new Uint8Array([1]).buffer); await storage.saveOperation(K1, { phase: "committed" });
  await storage.stage(K2, new Uint8Array([2]).buffer);
  await storage.release(K1); await storage.release(K1);
  expect(await fs.readdir(root)).toEqual([K2 + ".blob"]);
  await expect(storage.release("../escape")).rejects.toThrow(/identity/);
}));

it("gc keeps prepared operations and the retained batch, and removes the rest including temp files", () => withRoot(async root => {
  const storage = new SyncPrivateStorage(root);
  await storage.stage(K1, new Uint8Array([1]).buffer); await storage.saveOperation(K1, { id: K1, phase: "prepared", payload: { key: K1 } });
  await storage.stage(K2, new Uint8Array([2]).buffer); await storage.saveOperation(K2, { id: K2, phase: "committed" });
  await storage.stage(K3, new Uint8Array([3]).buffer); // orphan blob, no journal
  await fs.writeFile(path.join(root, K3 + ".blob.abc.tmp"), "partial");
  expect((await storage.gc([])).removed).toBe(4);
  expect((await fs.readdir(root)).sort()).toEqual([K1 + ".blob", K1 + ".json"]);
  await storage.saveOperation(K2, { id: K2, phase: "committed" });
  await storage.gc([K2]);
  expect((await fs.readdir(root)).sort()).toEqual([K1 + ".blob", K1 + ".json", K2 + ".json"]);
  expect(await new SyncPrivateStorage(path.join(root, "missing")).gc()).toEqual({ removed: 0 });
}));

it("sweepBindings removes stale binding dirs but skips ones that could still resume, and force removes everything", () => withRoot(async root => {
  const live = "a".repeat(64), stale = "b".repeat(64), resumable = "c".repeat(64);
  for (const name of [live, stale, resumable]) await fs.mkdir(path.join(root, name));
  await fs.writeFile(path.join(root, stale, K1 + ".json"), JSON.stringify({ phase: "committed" }));
  await fs.writeFile(path.join(root, resumable, K1 + ".json"), JSON.stringify({ phase: "prepared" }));
  await fs.mkdir(path.join(root, "not-a-binding"));
  expect(await SyncPrivateStorage.sweepBindings(root, [live], false)).toEqual({ removed: [stale], skipped: [resumable] });
  expect((await fs.readdir(root)).sort()).toEqual([live, "not-a-binding", resumable].sort());
  await fs.rm(path.join(root, "not-a-binding"), { recursive: true });
  expect((await SyncPrivateStorage.sweepBindings(root, [], true)).removed.sort()).toEqual([live, resumable].sort());
  await expect(fs.stat(root)).rejects.toThrow();
}));
