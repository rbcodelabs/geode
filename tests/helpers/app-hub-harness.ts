import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listVaultFiles } from "../../src/main/vault-files";
import { dispatchHubRequest } from "../../src/main/hub-sync-ipc";
import { HubStoreManager, type HubStoreManagerOptions } from "../../src/sync-node/app-hub";
import { SyncPrivateStorage, applyGuardedMutation } from "../../src/sync-node/index";
import { SyncService } from "../../src/renderer/sync/sync-service";
import { HUB_PROVIDER_ID, HubSyncProvider } from "../../src/renderer/sync/hub-provider";
import type { HubRequest, HubSyncBridge, HubTarget } from "../../src/shared/hub-sync";
import type { SyncStorageRequest } from "../../src/shared/sync-safety";

/**
 * The renderer half (SyncService + HubSyncProvider) wired to the real main-process half (dispatchHubRequest +
 * HubStoreManager) through a bridge that structured-clones every request and response, as Electron IPC does, so a
 * value IPC could not carry fails here too. The device's vault is a real directory scanned with the app's own
 * strict scan and changed through the app's own guarded apply; only Electron's window plumbing is absent.
 */
export const tmpDir = (prefix: string) => mkdtempSync(join(tmpdir(), `geode-${prefix}-`));
export const rmrf = (path: string) => rmSync(path, { recursive: true, force: true });

export function inProcessBridge(manager: HubStoreManager, owner = "window-1"): HubSyncBridge & { requests: string[] } {
  const inflight = new Map<string, AbortController>();
  const requests: string[] = [];
  return {
    requests,
    async call(request: HubRequest, requestId: string) {
      requests.push(request.method);
      const abort = new AbortController(); inflight.set(requestId, abort);
      try { return structuredClone(await dispatchHubRequest(manager, owner, structuredClone(request), abort.signal)) as never; }
      finally { inflight.delete(requestId); }
    },
    abort(requestId: string) { inflight.get(requestId)?.abort(); },
  };
}

export function appDevice(options: { vault: string; userData: string; hub?: HubTarget; create?: boolean; manager?: HubStoreManagerOptions }) {
  const { vault, userData } = options;
  const state = new Map<string, unknown>();
  const manager = new HubStoreManager(options.manager);
  const bridge = inProcessBridge(manager);
  const storage = async (_token: string, binding: string, request: SyncStorageRequest): Promise<unknown> => {
    const root = join(userData, "ops"), store = new SyncPrivateStorage(join(root, binding));
    switch (request.action) {
      case "stage": return store.stage(request.key, request.data);
      case "read-stage": return store.readStage(request.key);
      case "save-operation": return store.saveOperation(request.key, request.value);
      case "load-operations": return store.loadOperations();
      case "release": return store.release(request.key);
      case "gc": return store.gc(request.retain);
      case "sweep": return SyncPrivateStorage.sweepBindings(root, request.keep, request.force === true);
    }
  };
  const host = {
    deviceState: {
      read: async (key: string) => state.has(key) ? structuredClone(state.get(key)) : null,
      write: async (key: string, value: unknown) => { state.set(key, structuredClone(value)); },
      remove: async (key: string) => { state.delete(key); },
    },
    syncSafety: {
      claimOwner: async () => "owner-lease",
      releaseOwner: async () => {},
      storage,
      apply: async (_token: string, input: Parameters<typeof applyGuardedMutation>[2]) => applyGuardedMutation(vault, join(userData, "recovery"), input, { trashDir: join(userData, "trash") }),
      onPrepare: () => () => {}, onRelease: () => () => {},
    },
    vaultFiles: {
      onChange: () => () => {},
      reconcileScan: async () => {
        const blocked: Array<{ path: string; reason: string }> = [];
        const entries = await listVaultFiles(vault, { strictSync: true, onBlocked: issue => blocked.push(issue) });
        return { status: "complete" as const, entries, ...(blocked.length ? { blocked } : {}) };
      },
      readBinary: async (path: string) => { const bytes = readFileSync(join(vault, path)); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; },
    },
    config: { read: async () => null },
  };
  const service = new SyncService(host as never, () => vault);
  const provider = new HubSyncProvider(bridge, host.deviceState, () => vault);
  const device = {
    vault, userData, service, provider, manager, bridge, host,
    /** Stops the poll / debounce timers so a step is exactly one sync. */
    async settle() { await service.cancel(); },
    async configure(hub: HubTarget, create = false) { await provider.setConfig({ schema: 1, target: hub, create }); },
    /** Registers the built-in provider, selects it, joins the hub's one vault (or creates it). */
    async connect(mode: "join" | { create: string }) {
      service.register("geode", provider);
      await service.activate(HUB_PROVIDER_ID);
      if (mode === "join") { const [vaultDescriptor] = await service.discoverVaults(); if (!vaultDescriptor) throw new Error("hub holds no vault"); await service.joinVault(vaultDescriptor); }
      else await service.createVault(mode.create);
    },
    /** Preview, then confirm: the documented first-run ritual. */
    async firstSync() { const preview = await service.preview(); const result = await service.run({ approvePreview: true }); await device.settle(); return { preview, result }; },
    /** The unattended path: a plain run, no approval. */
    async sync() { try { return await service.run(); } finally { await device.settle(); } },
    async close() { await service.cancel(); await manager.closeOwner("window-1"); },
  };
  return device;
}

/** Every non-dot file under `root` as relative path -> text. Dot paths (config roots, trash) are not content. */
export function tree(root: string, dir = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(root, dir)).sort()) {
    if (name.startsWith(".")) continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) Object.assign(out, tree(root, rel)); else out[rel] = readFileSync(join(root, rel), "utf8");
  }
  return out;
}

/**
 * CONTENT history records (and the distinct blobs they reference) in a directory hub: a sync that has nothing new
 * to say about content must leave this unchanged. Portable-config documents (the app publishes its projected
 * settings; the CLI publishes raw config files) are a separate namespace and deliberately not counted.
 */
export function hubCounts(hub: string): { records: number; blobs: number } {
  const files = (dir: string): string[] => { try { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.includes(".tmp") ? [] : [join(dir, entry.name)]); } catch { return []; } };
  const records = files(join(hub, "records")).map(file => JSON.parse(readFileSync(file, "utf8")) as { namespace: string; blob?: { id: string } }).filter(record => record.namespace === "content");
  return { records: records.length, blobs: new Set(records.flatMap(record => record.blob ? [record.blob.id] : [])).size };
}

export const ensureDir = (path: string) => mkdirSync(path, { recursive: true });
