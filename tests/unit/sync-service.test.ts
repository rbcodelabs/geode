import { expect, it, vi } from "vitest";
import { SyncService } from "../../src/renderer/sync/sync-service";
import { APPEND_ONLY_PROTOCOL } from "../../src/renderer/sync/history-types";

it("never reports idle for unresolved integrity or queued actions", () => {
  const service = new SyncService({} as never, () => "/synthetic/vault");
  (service as any).selected = { id: "history" };
  const result = { signature: "preview", requiresApproval: false, uploads: 0, downloads: 0, deletions: 0, conflicts: [], blocked: [], excluded: [], pending: 0, upToDate: false };
  (service as any).summarize(result); expect(service.getStatus().state).toBe("error");
  (service as any).summarize({ ...result, uploads: 1 }); expect(service.getStatus().state).toBe("pending");
});

it("cancels discovery and rejects late results when the vault changes", async () => {
  let finish!: (value: unknown[]) => void; let root = "/synthetic/old"; let signal!: AbortSignal;
  const service = new SyncService({} as never, () => root);
  (service as any).selected = { discover: (_signal: AbortSignal) => { signal = _signal; return new Promise(resolve => { finish = resolve; }); } };
  const pending = service.discoverVaults(); const rejection = expect(pending).rejects.toThrow(/changed/);
  root = "/synthetic/new"; const cancelled = service.cancel(); expect(signal.aborted).toBe(true); finish([]);
  await rejection; await cancelled;
});

it("does not resurrect a binding when disconnect races the join state read", async () => {
  const descriptor = { schema: 1, protocol: APPEND_ONLY_PROTOCOL, vaultId: "12345678-1234-4234-8234-123456789012", rootId: "root", descriptorId: "descriptor", name: "Shared" };
  const writes: unknown[] = []; let finish!: (value: unknown) => void;
  const service = new SyncService({ deviceState: { read: (key: string) => key.startsWith('sync/') ? Promise.resolve(null) : new Promise(resolve => { finish = resolve; }), write: async (key: string, value: unknown) => { if (!key.startsWith('sync/')) writes.push(value); }, remove: async () => {} } } as never, () => "/synthetic/vault");
  (service as any).selected = { id: "history", discover: async () => [descriptor] };
  const joining = service.joinVault(descriptor as never); const rejected = expect(joining).rejects.toThrow();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const disconnecting = service.disconnect(); finish(null);
  await rejected; await disconnecting; expect(writes).toEqual([]);
});

for (const action of ["disconnect", "unregister"] as const) it(`cancels first activation when ${action} happens before selection`, async () => {
  let finish!: (value: unknown) => void; const write = vi.fn(async (_key: string, _value: unknown) => {});
  const service = new SyncService({ deviceState: { read: (key: string) => key.startsWith('sync/') ? Promise.resolve(null) : new Promise(resolve => { finish = resolve; }), write, remove: async () => {} }, syncSafety: {}, vaultFiles: { onChange: () => () => {} } } as never, () => "/synthetic/vault");
  (service as any).restore = async () => {};
  const unregister = service.register("owner", { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } } as never);
  const activation = service.activate("history"); const rejection = expect(activation).rejects.toThrow(/changed/);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const closing = action === "disconnect" ? service.disconnect() : unregister(); finish(null);
  await rejection; await closing; expect(write.mock.calls.filter(([key]) => !key.startsWith('sync/'))).toEqual([]); expect(service.getActiveProvider()).toBeNull();
});

it("does not restore a persisted binding after disconnect during the registration read", async () => {
  let finish!: (value: unknown) => void;
  const remove = vi.fn(async () => {});
  const service = new SyncService({ deviceState: { read: () => new Promise(resolve => { finish = resolve; }), remove }, syncSafety: {}, vaultFiles: { onChange: () => () => {} } } as never, () => "/synthetic/vault");
  (service as any).conditional.disconnect = async () => {};
  service.register("owner", { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } } as never);
  await service.disconnect();
  finish({ schema: 1, localRoot: "/synthetic/vault", providerId: "history", paused: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(service.getActiveProvider()).toBeNull();
  expect(remove).toHaveBeenCalledWith("sync-history-binding//synthetic/vault");
});

it("disconnects the conditional provider even while an append-only restore is pending", async () => {
  let finish!: (value: unknown) => void;
  const service = new SyncService({ deviceState: { read: () => new Promise(resolve => { finish = resolve; }), remove: async () => {} }, syncSafety: {} } as never, () => "/synthetic/vault");
  const disconnect = vi.fn(async () => {});
  (service as any).conditional.getActiveProvider = () => ({ id: "conditional", name: "Conditional" });
  (service as any).conditional.disconnect = disconnect;
  service.register("owner", { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } } as never);
  await service.disconnect(); finish(null);
  expect(disconnect).toHaveBeenCalledOnce();
});

it("conditional activation invalidates a pending history restoration", async () => {
  let finish!: (value: unknown) => void; let active: unknown = null;
  const service = new SyncService({ deviceState: { read: () => new Promise(resolve => { finish = resolve; }) }, syncSafety: {}, vaultFiles: { onChange: () => () => {} } } as never, () => "/synthetic/vault");
  const conditional = { id: "conditional", name: "Conditional" };
  (service as any).providers.set(conditional.id, conditional);
  (service as any).conditional.activate = async () => { active = conditional; };
  (service as any).conditional.getActiveProvider = () => active;
  service.register("owner", { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } } as never);
  await service.activate("conditional");
  finish({ schema: 1, localRoot: "/synthetic/vault", providerId: "history", paused: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(service.getActiveProvider()).toEqual(conditional); expect(service.isAppendOnly()).toBe(false);
});

it("rejects conditional activation while the first history activation is pending", async () => {
  let finish!: (value: unknown) => void;
  const service = new SyncService({ deviceState: { read: () => new Promise(resolve => { finish = resolve; }), write: async () => {} }, vaultFiles: { onChange: () => () => {} } } as never, () => "/synthetic/vault");
  (service as any).providers.set("history", { id: "history", protocol: APPEND_ONLY_PROTOCOL });
  (service as any).providers.set("conditional", { id: "conditional" });
  (service as any).conditional.activate = vi.fn(async () => {});
  const activating = service.activate("history");
  try { await expect(service.activate("conditional")).rejects.toThrow(/running|disconnect/i); }
  finally { finish(null); await activating; }
  expect((service as any).conditional.activate).not.toHaveBeenCalled();
});

const conditionalCapabilities = { binary: true, conditionalWrites: true, delta: true, completeSnapshots: true, atomicMoves: true, trash: true };

it("waits for conditional hydration before allowing append activation", async () => {
  let finish!: (value: unknown) => void;
  const service = new SyncService({ deviceState: { read: (key: string) => key.startsWith('sync/') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null), write: async () => {} }, syncSafety: {}, vaultFiles: { onChange: () => () => {} } } as never, () => "/synthetic/vault");
  service.register("owner", { id: "conditional", name: "Conditional", capabilities: conditionalCapabilities } as never);
  (service as any).providers.set("history", { id: "history", protocol: APPEND_ONLY_PROTOCOL });
  const activation = service.activate("history"); const rejection = expect(activation).rejects.toThrow(/disconnect/i);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); finish({ providerId: 'conditional' });
  await rejection; expect(service.isAppendOnly()).toBe(false);
});

it("suppresses conditional hydration when an append provider already owns the facade", async () => {
  const service = new SyncService({ deviceState: { read: async () => ({ providerId: 'conditional' }) } } as never, () => "/synthetic/vault");
  (service as any).selected = { id: 'history' };
  service.register("owner", { id: "conditional", name: "Conditional", capabilities: conditionalCapabilities } as never);
  await (service as any).conditional.hydration;
  expect((service as any).conditional.getActiveProvider()).toBeNull();
});

for (const boundary of ['read', 'write'] as const) it(`suppresses a newly registered conditional provider during append activation ${boundary}`, async () => {
  let release!: () => void;
  const service = new SyncService({ deviceState: {
    read: async (key: string) => key.startsWith('sync/') ? { providerId: 'conditional' } : boundary === 'read' ? new Promise(resolve => { release = () => resolve(null); }) : null,
    write: async () => { if (boundary === 'write') await new Promise<void>(resolve => { release = resolve; }); },
  }, vaultFiles: { onChange: () => () => {} } } as never, () => "/synthetic/vault");
  (service as any).providers.set('history', { id: 'history', protocol: APPEND_ONLY_PROTOCOL });
  const activating = service.activate('history');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  service.register('owner', { id: 'conditional', name: 'Conditional', capabilities: conditionalCapabilities } as never);
  await (service as any).conditional.hydration;
  release(); await activating;
  expect(service.isAppendOnly()).toBe(true); expect((service as any).conditional.getActiveProvider()).toBeNull();
});

it("does not revive conditional hydration admitted during disconnect cleanup", async () => {
  let reads = 0; let finishRead!: (value: unknown) => void; let finishWrite!: () => void;
  const service = new SyncService({ deviceState: {
    read: async () => ++reads === 1 ? null : new Promise(resolve => { finishRead = resolve; }),
    write: async () => new Promise<void>(resolve => { finishWrite = resolve; }),
    remove: async () => {},
  } } as never, () => '/synthetic/vault');
  const disconnecting = service.disconnect();
  await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
  service.register('owner', { id: 'conditional', name: 'Conditional', capabilities: conditionalCapabilities } as never);
  await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
  finishWrite(); await disconnecting;
  finishRead({ providerId: 'conditional' }); await (service as any).conditional.hydration;
  expect(service.getActiveProvider()).toBeNull();
});

it("clears a persisted conditional selection even when that plugin is unregistered", async () => {
  const state = new Map<string, any>([['sync/%2Fsynthetic%2Fvault', { providerId: 'unregistered' }]]);
  const service = new SyncService({ deviceState: { read: async (key: string) => state.get(key) ?? null, write: async (key: string, value: unknown) => { state.set(key, value); }, remove: async (key: string) => { state.delete(key); } } } as never, () => '/synthetic/vault');
  (service as any).selected = { id: 'history' };
  await service.disconnect();
  expect(state.get('sync/%2Fsynthetic%2Fvault').providerId).toBeUndefined();
});

it("clears a persisted append selection even when that plugin is unregistered", async () => {
  const key = 'sync-history-binding//synthetic/vault';
  const state = new Map<string, unknown>([[key, { providerId: 'unregistered' }]]);
  const service = new SyncService({ deviceState: { read: async (key: string) => state.get(key) ?? null, write: async (key: string, value: unknown) => { state.set(key, value); }, remove: async (key: string) => { state.delete(key); } } } as never, () => '/synthetic/vault');
  await service.disconnect(); expect(state.has(key)).toBe(false);
});

it("cancels conditional initialization before opening a session and switching protocols", async () => {
  let reads = 0; let finish!: (value: unknown) => void;
  const open = vi.fn(async () => { throw new Error('Old provider session opened'); });
  const service = new SyncService({ deviceState: { read: async (key: string) => {
    if (!key.startsWith('sync/')) return null;
    reads++; if (reads === 2) return new Promise(resolve => { finish = resolve; });
    return reads === 1 ? { providerId: 'conditional' } : null;
  }, write: async () => {}, remove: async () => {} }, vaultFiles: { onChange: () => () => {} } } as never, () => "/synthetic/vault");
  service.register('owner', { id: 'conditional', name: 'Conditional', capabilities: conditionalCapabilities, open } as never);
  await (service as any).conditional.hydration;
  const running = service.run(); const rejection = expect(running).rejects.toThrow();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const disconnecting = service.disconnect(); finish({ providerId: 'conditional', approved: true });
  await rejection; await disconnecting;
  (service as any).providers.set('history', { id: 'history', protocol: APPEND_ONLY_PROTOCOL });
  await service.activate('history');
  expect(open).not.toHaveBeenCalled(); expect(service.isAppendOnly()).toBe(true);
});

it("does not rearm retries or replace paused status from an old scheduled failure", async () => {
  vi.useFakeTimers();
  try {
    let fail!: (error: Error) => void;
    const service = new SyncService({} as never, () => "/synthetic/vault");
    (service as any).selected = { id: "history" }; (service as any).status = { state: "idle", conflicts: 0 };
    service.run = vi.fn(() => new Promise((_resolve, reject) => { fail = reject; }));
    (service as any).schedule(0); await vi.advanceTimersByTimeAsync(0);
    await service.cancel(); (service as any).status = { state: "paused", conflicts: 0 };
    fail(new Error("old request failed")); await vi.advanceTimersByTimeAsync(0);
    expect(service.getStatus().state).toBe("paused"); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("keeps structural parents and trusted renamed identities in Markdown-only scope", async () => {
  const stored = new Map(); const operations = new Map(); const blobs = new Map(); const records: any[] = [];
  let changed: (event: any) => void = () => {};
  let files = [{ path: "Folder", isFolder: true, size: 0, mtime: 1, ctime: 1 }, { path: "Folder/Note.md", isFolder: false, size: 3, mtime: 1, ctime: 1 }];
  let text = "old";
  const descriptor = { schema: 1, protocol: APPEND_ONLY_PROTOCOL, vaultId: "12345678-1234-4234-8234-123456789012", rootId: "root", descriptorId: "descriptor", name: "Shared" };
  const host = { config: { read: async () => null }, deviceState: { read: async (key: string) => structuredClone(stored.get(key) ?? null), write: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); } },
    vaultFiles: { onChange: (callback: any) => { changed = callback; return () => {}; }, reconcileScan: async () => ({ status: "complete", entries: files }), readBinary: async () => new TextEncoder().encode(text).buffer },
    syncSafety: { claimOwner: async () => "lease", releaseOwner: async () => {}, storage: async (_token: string, _binding: string, request: any) => { if (request.action === "load-operations") return [...operations.values()]; if (request.action === "save-operation") { operations.set(request.key, structuredClone(request.value)); return; } if (request.action === "stage") { blobs.set(request.key, request.data.slice(0)); return request.key; } return blobs.get(request.key).slice(0); } },
  };
  const service = new SyncService(host as never, () => "/synthetic/vault");
  service.register("owner", { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 }, discover: async () => [descriptor], createVault: async () => descriptor,
    open: async () => ({ scan: async () => ({ status: "complete", records: structuredClone(records) }), putBlob: async (input: any) => { blobs.set(input.operationId, input.data.slice(0)); return { id: input.operationId, sha256: input.sha256, size: input.size }; }, readBlob: async (ref: any) => blobs.get(ref.id).slice(0), appendRecord: async (record: any) => { if (!records.some(item => item.recordId === record.recordId)) records.push(structuredClone(record)); }, close: async () => {} }),
  } as never);
  try {
    await service.activate("history"); await service.createVault("Shared");
    await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
    expect((await service.preview()).uploads).toBe(2); await service.run({ approvePreview: true });
    const folder = records.find(record => record.kind === "folder"); const note = records.find(record => record.kind === "file");
    files = [{ ...files[0], path: "Moved" }, { ...files[1], path: "Moved/Note.md" }]; text = "new";
    changed({ event: "create-folder", path: "Moved", renamedFrom: "Folder" });
    await service.preview(); await service.run({ approvePreview: true });
    expect(service.getHistoryDetails()).toMatchObject({ conflicts: [], blocked: [] });
    expect(records.filter(record => record.entityId === folder.entityId).at(-1).location.name).toBe("Moved");
    expect(records.filter(record => record.entityId === note.entityId).at(-1).deleted).toBe(false);
    expect(new Set(records.map(record => record.entityId)).size).toBe(2);
  } finally { await service.cancel(); }
});

it("never disconnects the new vault after cancellation crosses a vault switch", async () => {
  let root = "/synthetic/old"; let release!: () => void;
  const remove = vi.fn();
  const service = new SyncService({ deviceState: { remove }, vaultFiles: { onChange: () => () => {} } } as never, () => root);
  (service as any).selected = { id: "history" };
  (service as any).running = new Promise<void>(resolve => { release = resolve; });
  const pending = service.disconnect(); root = "/synthetic/new"; release();
  await expect(pending).rejects.toThrow(/changed/); expect(remove).not.toHaveBeenCalled();
});

it("cancels active history work before changing scope", async () => {
  const stored = new Map();
  const service = new SyncService({ deviceState: { read: async (key: string) => stored.get(key) ?? null, write: async (key: string, value: unknown) => { stored.set(key, value); } }, vaultFiles: { onChange: () => () => {} } } as never, () => "/synthetic/vault");
  (service as any).selected = { id: "history" };
  const abort = new AbortController(); (service as any).abort = abort;
  await service.updateScope({ markdown: false }); expect(abort.signal.aborted).toBe(true); expect(service.getStatus().state).toBe("preview");
});

it("requires explicit create or join and persists creation identity before remote mutation", async () => {
  const stored = new Map<string, unknown>();
  const descriptor = { schema: 1, protocol: APPEND_ONLY_PROTOCOL, vaultId: "12345678-1234-4234-8234-123456789012", rootId: "root", descriptorId: "descriptor", name: "Shared" };
  const createVault = vi.fn(async ({ operationId }) => { expect([...stored.values()].some(value => JSON.stringify(value).includes(operationId))).toBe(true); return descriptor; });
  const host = { deviceState: { read: async (key: string) => stored.get(key) ?? null, write: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); } }, vaultFiles: { onChange: () => () => {} }, syncSafety: { claimOwner: async () => "lease", releaseOwner: async () => {} } };
  const service = new SyncService(host as never, () => "/synthetic/vault");
  service.register("owner", { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 }, discover: async () => [descriptor], createVault, open: vi.fn() } as never);
  expect(service.listProviders()).toEqual([{ id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL }]);
  await service.activate("history");
  await expect(service.preview()).rejects.toThrow(/create|join/i);
  await service.createVault("Shared"); expect(createVault).toHaveBeenCalledOnce();
  expect(service.getStatus().state).toBe("preview");
  await service.cancel();
});
