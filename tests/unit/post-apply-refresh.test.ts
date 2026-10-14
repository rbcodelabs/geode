import { describe, expect, it } from "vitest";
import { createBrowserHost, createBrowserHostState } from "../../src/renderer/host/browser-host";
import { createCapacitorHost } from "../../src/renderer/host/capacitor-host";
import { PostApplyRefresh, type PostApplyRefreshDeps } from "../../src/renderer/sync/post-apply-refresh";
import type { ReconcileChange } from "../../src/renderer/reconciliation";
import type { SyncApplyOutcome } from "../../src/shared/sync-safety";
import { FakeManagedVault } from "../helpers/fake-managed-vault";

const ROOT = "managed://default";

/** A phone's safety service whose release handler is the real PostApplyRefresh over counting fakes. */
async function phone(options: { scoped: boolean; refreshMs?: number; slowMs?: number; failRefresh?: boolean }) {
  const native = new FakeManagedVault(ROOT);
  const list = native.plugin.list.bind(native.plugin); native.plugin.list = async () => { native.calls.push("list"); return list(); };
  const host = createCapacitorHost(native.plugin, createBrowserHost(createBrowserHostState()));
  await host.vaultRegistry.openVault(ROOT);
  const safety = host.syncSafety!;
  const token = (await safety.claimOwner())!;
  const known = new Set<string>(), counts = { fullScans: 0, scopedBatches: 0, scopedChanges: 0, held: 0, finished: 0, settings: 0 }, batches: ReconcileChange[][] = [];
  let successes = 0, running: Promise<unknown> | null = null;
  const lifted: Array<() => void> = [];
  const deps: PostApplyRefreshDeps = {
    hasFile: path => known.has(path), hasFolder: () => false,
    refreshChanges: async changes => {
      counts.scopedBatches++; counts.scopedChanges += changes.length; batches.push(changes);
      await new Promise(resolve => setTimeout(resolve, options.refreshMs ?? 0));
      if (!options.failRefresh) { successes++; for (const change of changes) known.add(change.path); lifted.splice(0).forEach(fn => fn()); }
    },
    refreshAll: async () => { counts.fullScans++; await host.vaultFiles.reconcileScan(); successes++; },
    fullInFlight: () => running, successCount: () => successes,
    reloadPortableSettings: async () => { counts.settings++; },
    holdStale: () => { counts.held++; lifted.push(() => { counts.finished++; }); }, finishGuard: () => { counts.finished++; },
    assertLive: () => {}, ...(options.slowMs !== undefined ? { slowMs: options.slowMs } : {}),
  };
  const refresh = new PostApplyRefresh(deps);
  safety.onRelease(async (guard, outcome) => { await refresh.release(guard, options.scoped ? outcome : undefined); });
  const write = (path: string, text: string) => safety.apply(token, { operationId: crypto.randomUUID(), path, expectedHash: null, kind: "write", data: new TextEncoder().encode(text).buffer as ArrayBuffer });
  return { native, safety, token, counts, batches, write, host };
}

const nativeLists = (p: { native: FakeManagedVault }) => p.native.calls.filter(call => call === "list").length;
describe("per-file editor refresh after a guarded apply", () => {
  const FILES = 120;
  it("a full vault rescan per applied file (the host that cannot say what it changed) versus none", async () => {
    const before = await phone({ scoped: false });
    for (let i = 0; i < FILES; i++) await before.write(`Folder${i % 8}/note ${i}.md`, `n${i}`);
    const after = await phone({ scoped: true });
    for (let i = 0; i < FILES; i++) await after.write(`Folder${i % 8}/note ${i}.md`, `n${i}`);
    // Measured: 120 files -> full rescans / native list calls
    expect({ fullScans: before.counts.fullScans, scopedChanges: before.counts.scopedChanges }).toEqual({ fullScans: FILES, scopedChanges: 0 });
    expect({ fullScans: after.counts.fullScans, scopedChanges: after.counts.scopedChanges }).toEqual({ fullScans: 0, scopedChanges: FILES });
    expect(after.native.files.size).toBe(FILES);
    expect(nativeLists(before)).toBe(FILES); expect(nativeLists(after)).toBe(0); // full-vault native `list` calls
    expect(after.counts.fullScans).toBe(0);
    expect(after.counts.settings).toBe(0); // content files do not reload settings either
  });

  it("a refresh slower than the guard's patience no longer fails the apply; views stay read-only until it completes", async () => {
    const p = await phone({ scoped: true, refreshMs: 60, slowMs: 10 });
    const result = await p.write("Notes/slow.md", "slow");
    expect(result.status).toBe("applied");
    expect(p.counts.held).toBe(1); expect(p.counts.finished).toBe(0); // hold taken, guard not released yet
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(p.counts.finished).toBe(1);                                 // the completed refresh lifted the hold
    expect(p.native.text("Notes/slow.md")).toBe("slow");
  });

  it("refreshes that pile up behind a slow one are applied as batches, not one by one", async () => {
    const p = await phone({ scoped: true, refreshMs: 40, slowMs: 5 });
    for (let i = 0; i < 12; i++) await p.write(`B/n${i}.md`, `n${i}`);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(p.counts.scopedChanges).toBe(12);
    expect(p.counts.scopedBatches).toBeLessThan(12);
    expect(p.counts.finished).toBe(p.counts.held);
  });

  it("a refresh that actually FAILS still fails the apply (sync retries) and keeps the hold", async () => {
    const p = await phone({ scoped: true, failRefresh: true });
    await expect(p.write("Notes/bad.md", "x")).rejects.toThrow(/Editor refresh incomplete/);
    expect(p.counts.held).toBe(1); expect(p.counts.finished).toBe(0);
  });

  it("settings documents re-read settings only; a failed apply refreshes nothing", async () => {
    const p = await phone({ scoped: true });
    await p.safety.apply(p.token, { operationId: crypto.randomUUID(), namespace: "portable-config", path: "hotkeys.json", expectedHash: null, kind: "write", data: new TextEncoder().encode(JSON.stringify({ version: 1, overrides: {} })).buffer as ArrayBuffer }).catch(() => undefined);
    p.native.put("Notes/x.md", "x");
    await expect(p.write("Notes/x.md", "new")).rejects.toThrow(); // create over an existing file: hash guard refuses
    expect(p.counts.scopedChanges).toBe(0); expect(p.counts.fullScans).toBe(0);
  });

  it("describes trash and mkdir without scanning", () => {
    const refresh = new PostApplyRefresh({ hasFile: path => path === "a.md", hasFolder: path => path === "dir", refreshChanges: async () => {}, refreshAll: async () => {}, fullInFlight: () => null, successCount: () => 0, reloadPortableSettings: async () => {}, holdStale: () => {}, finishGuard: () => {}, assertLive: () => {} });
    const outcome = (kind: SyncApplyOutcome["kind"], path: string): SyncApplyOutcome => ({ namespace: "content", path, kind, changed: true });
    expect(refresh.changeFor(outcome("trash", "a.md"))).toEqual({ event: "delete", path: "a.md" });
    expect(refresh.changeFor(outcome("trash", "dir"))).toEqual({ event: "delete-folder", path: "dir" });
    expect(refresh.changeFor(outcome("trash", "gone.md"))).toBeNull();
    expect(refresh.changeFor(outcome("mkdir", "dir"))).toBeNull();
    expect(refresh.changeFor(outcome("mkdir", "new"))).toMatchObject({ event: "create-folder", path: "new" });
    expect(refresh.changeFor({ ...outcome("write", "a.md"), size: 9 })).toMatchObject({ event: "modify", entry: { size: 9 } });
    expect(refresh.changeFor(outcome("write", "b.md"))).toMatchObject({ event: "create" });
  });
});
