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

it("does not admit append restoration during disconnect cleanup", async () => {
  let finishRead: ((value: unknown) => void) | undefined; let finishRemove!: () => void;
  const service = new SyncService({ deviceState: {
    read: async (key: string) => key.startsWith('sync/') ? null : new Promise(resolve => { finishRead = resolve; }),
    write: async () => {}, remove: async () => new Promise<void>(resolve => { finishRemove = resolve; }),
  }, syncSafety: {}, vaultFiles: { onChange: () => () => {} } } as never, () => '/synthetic/vault');
  const disconnecting = service.disconnect();
  await vi.waitFor(() => expect(finishRemove).toBeTypeOf('function'));
  service.register('owner', { id: 'history', name: 'History', protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } } as never);
  finishRemove(); await disconnecting;
  finishRead?.({ schema: 1, localRoot: '/synthetic/vault', providerId: 'history', paused: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(service.getActiveProvider()).toBeNull();
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

it("exposes the bound shared vault's own name after createVault, and clears it on disconnect", async () => {
  const stored = new Map<string, unknown>();
  const descriptor = { schema: 1, protocol: APPEND_ONLY_PROTOCOL, vaultId: "12345678-1234-4234-8234-123456789012", rootId: "root", descriptorId: "descriptor", name: "Rick's Notes" };
  const host = { deviceState: { read: async (key: string) => stored.get(key) ?? null, write: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); }, remove: async (key: string) => { stored.delete(key); } }, vaultFiles: { onChange: () => () => {} }, syncSafety: { claimOwner: async () => "lease", releaseOwner: async () => {} } };
  const service = new SyncService(host as never, () => "/synthetic/vault");
  service.register("owner", { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 }, discover: async () => [descriptor], createVault: async () => descriptor, open: vi.fn() } as never);
  expect(service.getBoundVaultName()).toBeUndefined();
  await service.activate("history");
  await service.createVault("Rick's Notes");
  expect(service.getBoundVaultName()).toBe("Rick's Notes");
  await service.disconnect();
  expect(service.getBoundVaultName()).toBeUndefined();
});

it("exposes the bound shared vault's own name after joinVault", async () => {
  const stored = new Map<string, unknown>();
  const descriptor = { schema: 1, protocol: APPEND_ONLY_PROTOCOL, vaultId: "12345678-1234-4234-8234-123456789012", rootId: "root", descriptorId: "descriptor", name: "Team Vault" };
  const host = { deviceState: { read: async (key: string) => stored.get(key) ?? null, write: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); }, remove: async () => {} }, vaultFiles: { onChange: () => () => {} }, syncSafety: { claimOwner: async () => "lease", releaseOwner: async () => {} } };
  const service = new SyncService(host as never, () => "/synthetic/vault");
  service.register("owner", { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 }, discover: async () => [descriptor], open: vi.fn() } as never);
  await service.activate("history");
  await service.joinVault(descriptor as never);
  expect(service.getBoundVaultName()).toBe("Team Vault");
});

it("clears stale blocked/excluded details when the append-only provider unloads", async () => {
  const service = new SyncService({ deviceState: { read: async () => null }, syncSafety: {} } as never, () => "/synthetic/vault");
  (service as any).restore = async () => {};
  const provider = { id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } };
  const unregister = service.register("owner", provider as never);
  (service as any).selected = provider;
  const blocked = [{ namespace: "content", path: "Weird<1>.md", reason: "invalid-resource-name" }];
  (service as any).summarize({ signature: "s", requiresApproval: false, uploads: 0, downloads: 0, deletions: 0, conflicts: [], blocked, excluded: [], pending: 0, upToDate: false });
  expect(service.getHistoryDetails()?.blocked).toEqual(blocked);
  await unregister();
  // Rendering blocked/excluded is unconditional (not gated on isAppendOnly()) so the plain
  // sync path can show them too — stale details here would keep painting this unloaded
  // provider's old blocked-file groups on screen indefinitely.
  expect(service.getHistoryDetails()).toBeUndefined();
  expect(service.isAppendOnly()).toBe(false);
});

it("summarizes blocked files into a short status message while keeping the full per-file list on details", () => {
  const service = new SyncService({} as never, () => "/synthetic/vault");
  (service as any).selected = { id: "history" };
  const blocked = Array.from({ length: 23 }, (_, index) => ({ namespace: "content", path: `Weird<${index}>.md`, reason: "invalid-resource-name" }));
  const result = { signature: "preview", requiresApproval: false, uploads: 0, downloads: 0, deletions: 0, conflicts: [], blocked, excluded: [], pending: 0, upToDate: false };
  (service as any).summarize(result);
  expect(service.getStatus().message).toBe("23 file(s) blocked");
  expect(service.getStatus().message).not.toContain("Weird");
  expect(service.getHistoryDetails()?.blocked).toEqual(blocked);
});

// ---------------------------------------------------------------------------
// Local file-hash cache (host.hashCache): sync-service.ts's `snapshot` closure
// checks a persisted (path, size, mtime) -> sha256 cache before paying a full
// binary read + SHA-256 for each scanned entry. These tests exercise that
// through the real preview() -> plan() -> snapshot() path, stubbing only
// host.vaultFiles/host.hashCache/host.syncSafety, exactly like the existing
// "keeps structural parents..." test above.
type TestHashCacheEntry = { mtimeMs: number; size: number; sha256: string; excludeReason: string | null; providerId: string };

function makeHashCacheHarness(
  files: { path: string; isFolder: boolean; size: number; mtime: number; ctime: number }[],
  text: Record<string, string>,
  options: { providerId?: string; excludePath?: (path: string, data?: ArrayBuffer) => string | null } = {},
) {
  const stored = new Map<string, unknown>();
  const cacheRows = new Map<string, TestHashCacheEntry>();
  const providerId = options.providerId ?? "history";
  const descriptor = { schema: 1, protocol: APPEND_ONLY_PROTOCOL, vaultId: "12345678-1234-4234-8234-123456789012", rootId: "root", descriptorId: "descriptor", name: "Shared" };
  const readBinary = vi.fn(async (path: string) => new TextEncoder().encode(text[path]).buffer);
  const hashCache = {
    readAll: vi.fn(async () => Object.fromEntries(cacheRows)),
    upsertBatch: vi.fn(async (entries: Record<string, TestHashCacheEntry>) => { for (const [path, entry] of Object.entries(entries)) cacheRows.set(path, entry); }),
    prune: vi.fn(async (paths: string[]) => { const keep = new Set(paths); for (const path of [...cacheRows.keys()]) if (!keep.has(path)) cacheRows.delete(path); }),
  };
  const host = {
    config: { read: async () => null },
    deviceState: { read: async (key: string) => structuredClone(stored.get(key) ?? null), write: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); }, remove: async (key: string) => { stored.delete(key); } },
    vaultFiles: { onChange: () => () => {}, reconcileScan: async () => ({ status: "complete", entries: files }), readBinary },
    hashCache,
    syncSafety: { claimOwner: async () => "lease", releaseOwner: async () => {}, storage: async (_token: string, _binding: string, request: any) => request.action === "load-operations" ? [] : undefined },
  };
  const service = new SyncService(host as never, () => "/synthetic/vault");
  service.register("owner", {
    id: providerId, name: providerId, protocol: APPEND_ONLY_PROTOCOL,
    capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
    discover: async () => [descriptor], createVault: async () => descriptor,
    open: async () => ({ scan: async () => ({ status: "complete", records: [] }), close: async () => {} }),
    ...(options.excludePath ? { excludePath: options.excludePath } : {}),
  } as never);
  return { service, readBinary, hashCache, cacheRows, providerId };
}

it("reuses a cached hash and skips the binary read when a file's mtime and size are unchanged", async () => {
  const files = [{ path: "Note.md", isFolder: false, size: 3, mtime: 1, ctime: 1 }];
  const { service, readBinary, hashCache } = makeHashCacheHarness(files, { "Note.md": "old" });
  try {
    await service.activate("history"); await service.createVault("Shared");
    await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
    await service.preview();
    expect(readBinary).toHaveBeenCalledTimes(1);
    expect(hashCache.upsertBatch).toHaveBeenCalledWith({ "Note.md": { mtimeMs: 1, size: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), excludeReason: null, providerId: "history" } });

    readBinary.mockClear(); hashCache.upsertBatch.mockClear();
    await service.preview();
    expect(readBinary).not.toHaveBeenCalled();
    expect(hashCache.upsertBatch).not.toHaveBeenCalled();
  } finally { await service.cancel(); }
});

for (const changed of ["mtime", "size"] as const) it(`still re-hashes and updates the cache when a file's ${changed} changes`, async () => {
  const files = [{ path: "Note.md", isFolder: false, size: 3, mtime: 1, ctime: 1 }];
  const { service, readBinary, hashCache } = makeHashCacheHarness(files, { "Note.md": "old" });
  try {
    await service.activate("history"); await service.createVault("Shared");
    await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
    await service.preview();
    expect(readBinary).toHaveBeenCalledTimes(1);

    readBinary.mockClear(); hashCache.upsertBatch.mockClear();
    if (changed === "mtime") files[0].mtime = 2; else files[0].size = 4;
    await service.preview();
    expect(readBinary).toHaveBeenCalledTimes(1);
    expect(hashCache.upsertBatch).toHaveBeenCalledWith({ "Note.md": { mtimeMs: files[0].mtime, size: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), excludeReason: null, providerId: "history" } });
  } finally { await service.cancel(); }
});

it("prunes a removed file's cached hash on the next authoritative scan", async () => {
  const files = [
    { path: "Kept.md", isFolder: false, size: 3, mtime: 1, ctime: 1 },
    { path: "Removed.md", isFolder: false, size: 3, mtime: 1, ctime: 1 },
  ];
  const { service, hashCache, cacheRows } = makeHashCacheHarness(files, { "Kept.md": "old", "Removed.md": "old" });
  try {
    await service.activate("history"); await service.createVault("Shared");
    await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
    await service.preview();
    expect([...cacheRows.keys()].sort()).toEqual(["Kept.md", "Removed.md"]);

    files.splice(1, 1); // "Removed.md" no longer present in the scan
    await service.preview();
    expect(hashCache.prune).toHaveBeenCalledWith(["Kept.md"]);
    expect([...cacheRows.keys()]).toEqual(["Kept.md"]);
  } finally { await service.cancel(); }
});

it("does not trust a cache hit whose mtime is still within the racy-write window, even with a matching size", async () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    const files = [{ path: "Note.md", isFolder: false, size: 3, mtime: now, ctime: now }];
    const { service, readBinary, hashCache } = makeHashCacheHarness(files, { "Note.md": "old" });
    try {
      await service.activate("history"); await service.createVault("Shared");
      await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
      await service.preview(); // cold miss: populates the cache with mtime === now
      expect(readBinary).toHaveBeenCalledTimes(1);

      // Stat is unchanged and the wall clock hasn't moved, so the cached mtime is
      // still "now" — under RACY_WRITE_WINDOW_MS, this must be treated exactly like
      // a cold miss (fresh read + hash), not trusted as a hit.
      readBinary.mockClear(); hashCache.upsertBatch.mockClear();
      await service.preview();
      expect(readBinary).toHaveBeenCalledTimes(1);
      expect(hashCache.upsertBatch).toHaveBeenCalledWith({ "Note.md": { mtimeMs: now, size: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), excludeReason: null, providerId: "history" } });

      // Once the cached mtime has aged past the window (same stat, later wall
      // clock), the hit becomes trusted again — proving this isn't a permanent
      // "never trust this file" state, just a bounded settling window.
      vi.advanceTimersByTime(2000);
      readBinary.mockClear(); hashCache.upsertBatch.mockClear();
      await service.preview();
      expect(readBinary).not.toHaveBeenCalled();
      expect(hashCache.upsertBatch).not.toHaveBeenCalled();
    } finally { await service.cancel(); }
  } finally { vi.useRealTimers(); }
});

it("caches a path-based exclude verdict and never re-tests or re-reads the file while it stays excluded", async () => {
  const files = [{ path: "Secret.md", isFolder: false, size: 3, mtime: 1, ctime: 1 }];
  const excludePath = vi.fn((path: string) => path === "Secret.md" ? "matched .gitignore" : null);
  const { service, readBinary, hashCache, cacheRows } = makeHashCacheHarness(files, { "Secret.md": "old" }, { excludePath });
  try {
    await service.activate("history"); await service.createVault("Shared");
    await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
    await service.preview();
    expect(readBinary).not.toHaveBeenCalled(); // path-based exclusion needs no read at all
    expect(excludePath).toHaveBeenCalledTimes(1);
    expect(service.getHistoryDetails()?.excluded).toEqual([{ namespace: "content", path: "Secret.md", reason: "matched .gitignore" }]);
    expect(cacheRows.get("Secret.md")).toEqual({ mtimeMs: 1, size: 3, sha256: "", excludeReason: "matched .gitignore", providerId: "history" });

    excludePath.mockClear(); readBinary.mockClear(); hashCache.upsertBatch.mockClear();
    await service.preview();
    expect(readBinary).not.toHaveBeenCalled();
    expect(excludePath).not.toHaveBeenCalled(); // cache hit skips both exclude checks entirely
    expect(hashCache.upsertBatch).not.toHaveBeenCalled();
    expect(service.getHistoryDetails()?.excluded).toEqual([{ namespace: "content", path: "Secret.md", reason: "matched .gitignore" }]);
  } finally { await service.cancel(); }
});

it("caches a content-based exclude verdict and never re-reads the file while it stays excluded", async () => {
  const files = [{ path: "Binary.md", isFolder: false, size: 3, mtime: 1, ctime: 1 }];
  // Only the content-based hook (path, data) excludes this path — the path-only
  // hook returns null, so the first pass still has to pay for a read.
  const excludePath = vi.fn((_path: string, data?: ArrayBuffer) => data ? "binary content sniffed" : null);
  const { service, readBinary, hashCache, cacheRows } = makeHashCacheHarness(files, { "Binary.md": "old" }, { excludePath });
  try {
    await service.activate("history"); await service.createVault("Shared");
    await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
    await service.preview();
    expect(readBinary).toHaveBeenCalledTimes(1); // content-based check needed the bytes once
    expect(service.getHistoryDetails()?.excluded).toEqual([{ namespace: "content", path: "Binary.md", reason: "binary content sniffed" }]);
    expect(cacheRows.get("Binary.md")).toEqual({ mtimeMs: 1, size: 3, sha256: "", excludeReason: "binary content sniffed", providerId: "history" });

    excludePath.mockClear(); readBinary.mockClear(); hashCache.upsertBatch.mockClear();
    await service.preview();
    expect(readBinary).not.toHaveBeenCalled(); // cached verdict skips the read entirely on the next cycle
    expect(excludePath).not.toHaveBeenCalled();
    expect(hashCache.upsertBatch).not.toHaveBeenCalled();
  } finally { await service.cancel(); }
});

it("re-evaluates a cached exclude verdict under a newly-connected provider instead of inheriting the stale one", async () => {
  const files = [{ path: "Secret.md", isFolder: false, size: 3, mtime: 1, ctime: 1 }];
  const excludeAll = (path: string) => path === "Secret.md" ? "matched provider-a rule" : null;
  const { service, readBinary, cacheRows } = makeHashCacheHarness(files, { "Secret.md": "old" }, { providerId: "provider-a", excludePath: excludeAll });
  try {
    await service.activate("provider-a"); await service.createVault("Shared");
    await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
    await service.preview();
    expect(service.getHistoryDetails()?.excluded).toEqual([{ namespace: "content", path: "Secret.md", reason: "matched provider-a rule" }]);
    expect(cacheRows.get("Secret.md")).toEqual({ mtimeMs: 1, size: 3, sha256: "", excludeReason: "matched provider-a rule", providerId: "provider-a" });

    // Disconnect and connect a different provider whose excludePath does NOT
    // exclude this same, unchanged (mtime/size never moved) path. The stale
    // "provider-a" verdict cached above must not be inherited: the cache row's
    // providerId no longer matches the active provider, so this is a miss.
    await service.disconnect();
    const descriptor = { schema: 1, protocol: APPEND_ONLY_PROTOCOL, vaultId: "12345678-1234-4234-8234-123456789012", rootId: "root", descriptorId: "descriptor", name: "Shared" };
    service.register("owner", {
      id: "provider-b", name: "Provider B", protocol: APPEND_ONLY_PROTOCOL,
      capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
      discover: async () => [descriptor], createVault: async () => descriptor,
      open: async () => ({ scan: async () => ({ status: "complete", records: [] }), close: async () => {} }),
      excludePath: () => null, // provider-b has no such rule
    } as never);
    await service.activate("provider-b"); await service.createVault("Shared");
    await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });

    readBinary.mockClear();
    await service.preview();
    expect(readBinary).toHaveBeenCalledTimes(1); // re-evaluated fresh, not trusted from provider-a's cached verdict
    expect(service.getHistoryDetails()?.excluded).toEqual([]);
    expect(cacheRows.get("Secret.md")).toEqual({ mtimeMs: 1, size: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), excludeReason: null, providerId: "provider-b" });
  } finally { await service.cancel(); }
});
