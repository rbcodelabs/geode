import type { HistoryApply, HistoryControllerPorts, HistoryControllerState, HistoryLocalResource, HistoryLocalSnapshot, HistoryOperation } from "./history-controller";
import { SYNC_MAX_FILE_BYTES } from "./history-types";
import { isPathInSyncScope, type SyncScope } from "./scope";
import { isPortableAssetPath } from "../shared/portable-assets";
import type { GuardedMutation, GuardedMutationResult, SyncStorageRequest } from "../shared/sync-safety";

/**
 * The durable hash-cache row. Structurally identical to the renderer's
 * HashCacheEntry (host/contracts) so either side can hand its own to the other.
 */
export interface SyncHashCacheEntry { mtimeMs: number; size: number; sha256: string; excludeReason: string | null; providerId: string; }
export interface SyncVaultEntry { path: string; isFolder: boolean; mtime: number; size: number; }
export interface SyncVaultPathIssue { path: string; reason: string; }
/**
 * `blocked` paths exist (or may exist) locally but cannot be read right now
 * (iCloud placeholder, unsettled write, symlink...). The engine treats a blocked
 * path and everything beneath it as untouchable: never published, never deleted,
 * never overwritten. `excluded` paths are deliberately not synchronised.
 * Both are content-namespace paths and are optional (hosts that cannot tell omit them).
 */
export interface SyncVaultScan { status: "complete" | "partial" | "cancelled" | "unavailable"; entries: SyncVaultEntry[]; blocked?: SyncVaultPathIssue[]; excluded?: SyncVaultPathIssue[]; }
/**
 * Thrown by a host's readBinary when a file cannot be read *right now* for a
 * reason that is not an error in the file (e.g. iCloud evicted it mid-run).
 * The snapshot demotes just that resource to `blocked` instead of failing the run.
 * The reason is also embedded in the message as `[blocked:<reason>]`, which is
 * what survives an RPC boundary and lets later reads be labelled.
 */
export class SyncBlockedError extends Error {
  readonly syncBlockedReason: string;
  constructor(reason: string, detail?: string) { super(`[blocked:${reason}] ${detail ?? reason}`); this.name = "SyncBlockedError"; this.syncBlockedReason = reason; }
}
const blockedReasonOf = (error: unknown): string | null => {
  const direct = (error as { syncBlockedReason?: unknown } | null)?.syncBlockedReason;
  if (typeof direct === "string") return direct;
  return /\[blocked:([a-z0-9-]+)\]/.exec(error instanceof Error ? error.message : String(error))?.[1] ?? null;
};
export interface SyncPortableDocument {
  name: string;
  /** Serialized bytes of the document, exactly as they travel through history. */
  data: ArrayBuffer;
  /** Lazy so a read of one document never pays the config lookups of the others. */
  isInitialDefault(): Promise<boolean>;
}

/**
 * The narrow, platform-neutral slice of a host that the append-only history
 * engine needs: vault snapshot/list/read, a hash cache, device state, and the
 * guarded stage/apply storage. Electron's HostServices adapts to it today; a
 * headless (Node) host can implement it directly.
 */
export interface SyncHostLite {
  vault: {
    reconcileScan(): Promise<SyncVaultScan>;
    readBinary(path: string): Promise<ArrayBuffer>;
  };
  hashCache?: {
    readAll(): Promise<Record<string, SyncHashCacheEntry> | null>;
    upsertBatch(entries: Record<string, SyncHashCacheEntry>): Promise<void>;
    prune(keepPaths: string[]): Promise<void>;
  };
  deviceState: {
    read<T>(key: string): Promise<T | null>;
    write(key: string, value: unknown): Promise<void>;
  };
  safety: {
    storage(token: string, binding: string, request: SyncStorageRequest): Promise<unknown>;
    apply(token: string, input: GuardedMutation): Promise<GuardedMutationResult>;
  };
  portableConfig: {
    project(scope: SyncScope): Promise<SyncPortableDocument[]>;
  };
}

export interface HistoryPortsProvider {
  readonly id: string;
  excludePath?(path: string, data?: ArrayBuffer): string | null | Promise<string | null>;
}

export interface HistoryPortsContext {
  provider: HistoryPortsProvider;
  scope: SyncScope;
  /** VaultDescriptor.vaultId of the binding; seeds portable-config entity ids. */
  bindingVaultId: string;
  bindingKey: string;
  stateKey: string;
  lease: string;
  /** Throws when the run's vault/provider/generation has moved on. */
  assertContext(): void;
  /** destination -> original path, from live rename events. */
  renameHints: ReadonlyMap<string, string>;
  /** Fired after a portable-config mutation was applied. */
  portableChanged(): Promise<void>;
  now?(): number;
}

// The hash cache is durable (SQLite, survives app restarts), so a stat taken
// in the same instant as a write can be trusted forever once cached, not just
// until the next real edit — a much longer-lived hazard than the in-memory
// caches this pattern is normally borrowed from. Requiring the cached mtime
// to be at least this old before trusting a hit forces a just-touched file
// through a fresh read+hash (same as a cold miss) exactly once, after which
// its mtime has "aged out" and later hits are safe again. 2000ms mirrors
// SyncService.schedule()'s own default debounce — an already-established cadence
// for "let the filesystem settle", not a new arbitrary number.
export const RACY_WRITE_WINDOW_MS = 2000;

export const sha256Hex = async (data: ArrayBuffer): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(value => value.toString(16).padStart(2, "0")).join("");

/** Whether a (namespace, path) pair is synchronised under the given scope. */
export function isIncludedInScope(scope: SyncScope, namespace: string, path: string): boolean {
  if (namespace === "portable-config") {
    if (isPortableAssetPath(path)) return scope.themesAndSnippets;
    return path === "editor.json" ? scope.mainSettings : path === "appearance.json" ? scope.appearance : path === "hotkeys.json" ? scope.hotkeys : path === "daily-notes.json" && scope.corePlugins;
  }
  return !path.split("/").some(part => part.startsWith(".")) && isPathInSyncScope(path, scope);
}

/** UUIDv5-style stable id so every device derives the same entity for a portable-config path. */
export async function stableEntityId(vaultId: string, path: string): Promise<string> {
  const namespace = Uint8Array.from(vaultId.replace(/-/g, "").match(/../g)!, part => parseInt(part, 16));
  const name = new TextEncoder().encode("portable-config:" + path); const bytes = new Uint8Array(namespace.length + name.length); bytes.set(namespace); bytes.set(name, namespace.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)); digest[6] = (digest[6] & 15) | 80; digest[8] = (digest[8] & 63) | 128;
  const hex = [...digest.slice(0, 16)].map(value => value.toString(16).padStart(2, "0")).join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface HistoryPorts {
  ports: HistoryControllerPorts;
  /** The context-asserting guarded storage, also used for housekeeping outside the controller. */
  storage(request: SyncStorageRequest): Promise<unknown>;
}

/** Wires a SyncHostLite and a run context into the ports HistoryController consumes. */
export function buildHistoryPorts(host: SyncHostLite, ctx: HistoryPortsContext): HistoryPorts {
  const { provider, scope, assertContext, lease, bindingKey, stateKey } = ctx;
  const now = ctx.now ?? (() => Date.now());
  const included = (namespace: string, path: string) => isIncludedInScope(scope, namespace, path);
  const storage = async (request: SyncStorageRequest) => { assertContext(); const value = await host.safety.storage(lease, bindingKey, request); assertContext(); return value; };
  const read = async (resource: HistoryLocalResource): Promise<ArrayBuffer> => {
    assertContext();
    if (resource.namespace === "portable-config" && !isPortableAssetPath(resource.path)) {
      const documents = await host.portableConfig.project(scope); assertContext(); const doc = documents.find(item => item.name === resource.path); if (!doc) throw new Error("Portable category left scope"); return doc.data;
    }
    const data = await host.vault.readBinary(resource.namespace === "portable-config" ? ".geode/" + resource.path : resource.path); assertContext(); return data;
  };
  let includedAncestors = new Set<string>();
  // `onProgress` is what makes planning countable. reconcileScan() hands back
  // the whole entry list up front and costs comparatively nothing; the loop
  // below is where a 12 GB vault spends its time, because every entry pays a
  // full read, a SHA-256 and a content-based exclusion test. So the entry
  // count is a real denominator that is known before any of that work starts.
  // A tick per entry is negligible against a read plus a hash, and the 250 ms
  // throttle collapses them to ~4 status events/sec exactly as transfers do.
  const snapshot = async (onProgress?: (completed: number, total: number, currentPath?: string) => void): Promise<HistoryLocalSnapshot> => {
    const scan = await host.vault.reconcileScan(); assertContext();
    const result: HistoryLocalSnapshot = { authoritative: scan.status === "complete", scopeKey: JSON.stringify(scope), entries: [], excluded: [], blocked: [] };
    const folders = new Map<string, HistoryLocalResource>();
    const walked = scan.entries.length;
    let visited = 0;
    // Every entry pays a full binary read plus a SHA-256 (and, for content
    // paths, two provider exclude checks) on every preview()/run() cycle even
    // when its content hasn't changed since the last cycle — this cache
    // (persisted per vault, keyed by (path, size, mtime, providerId), see
    // HostServices.hashCache and metadata-cache-store.ts's hash_cache_entries
    // table) skips all of that for any entry whose stat still matches under
    // the currently-active provider, whether the cached verdict was "hash it"
    // or "exclude it" (excludeReason). Absent host support (mobile/browser,
    // where append-only sync never runs anyway) this degrades to the
    // unconditional behavior that existed before it.
    for (const issue of scan.blocked ?? []) result.blocked.push({ namespace: "content", path: issue.path, reason: issue.reason });
    for (const issue of scan.excluded ?? []) result.excluded.push({ namespace: "content", path: issue.path, reason: issue.reason });
    const hashCache = (await host.hashCache?.readAll()) ?? {}; assertContext();
    const hashCacheUpdates: Record<string, SyncHashCacheEntry> = {};
    for (const entry of scan.entries) {
      // Before the work, counting entries already finished — the same
      // convention `transferring` uses, so `completed` can never claim an
      // entry that has not been dealt with. Reported ahead of every `continue`
      // path so a vault full of skipped entries still advances.
      onProgress?.(visited++, walked, entry.path);
      const namespace = entry.path.startsWith(".geode/") ? "portable-config" : "content";
      const path = namespace === "portable-config" ? entry.path.slice(7) : entry.path;
      if (entry.isFolder) { if (!entry.path.split("/").some(part => part.startsWith(".")) || namespace === "portable-config" && isPortableAssetPath(path)) folders.set(`${namespace}:${path}`, { namespace, path, kind: "folder" }); continue; }
      if (!included(namespace, path) || namespace === "portable-config" && !isPortableAssetPath(path)) continue;
      const resource: HistoryLocalResource = { namespace, path, kind: "file", size: entry.size };
      if (entry.size > SYNC_MAX_FILE_BYTES) { result.blocked.push({ namespace, path, reason: "File exceeds 100 MiB limit" }); continue; }
      const cached = hashCache[entry.path];
      // A cache row is trusted only when: its stat still matches (as before);
      // it was written by *this* provider — excludePath()'s verdict is a
      // property of the active provider, not the file, so a reconnect to a
      // different provider must always re-evaluate a path rather than
      // silently inherit a stale include/exclude verdict for an unchanged
      // file; and its mtime is old enough to rule out a write racing the
      // stat that produced it (RACY_WRITE_WINDOW_MS above) — this cache is
      // durable across restarts, so an untrusted racy hit here would
      // otherwise stick indefinitely rather than self-correct on the next
      // real edit. Anything else is treated exactly like a cold miss,
      // including a fresh read+hash for a just-touched file.
      if (cached && cached.mtimeMs === entry.mtime && cached.size === entry.size && cached.providerId === provider.id
        && now() - entry.mtime >= RACY_WRITE_WINDOW_MS) {
        if (cached.excludeReason !== null) { result.excluded.push({ namespace, path, reason: cached.excludeReason }); continue; }
        // Verdict was "included": reuse the hash, no read, no digest, and no re-running either exclude check.
        resource.sha256 = cached.sha256;
      } else {
        const reason = namespace === "content" ? await provider.excludePath?.(path) : null; assertContext();
        if (reason) {
          // Cache the exclude verdict too — without this, an excluded file (e.g.
          // matched by a gitignore-style rule) gets fully re-tested, and for a
          // content-based rule re-read off disk, on every single cycle forever,
          // since only the hashed/included path ever wrote to the cache before.
          hashCacheUpdates[entry.path] = { mtimeMs: entry.mtime, size: entry.size, sha256: "", excludeReason: reason, providerId: provider.id };
          result.excluded.push({ namespace, path, reason }); continue;
        }
        let data: ArrayBuffer;
        try { data = await read(resource); } catch (error) {
          const blockedReason = blockedReasonOf(error);
          if (blockedReason === null) throw error;
          assertContext(); result.blocked.push({ namespace, path, reason: blockedReason }); continue;
        }
        const contentReason = namespace === "content" ? await provider.excludePath?.(path, data) : null; assertContext();
        if (contentReason) {
          hashCacheUpdates[entry.path] = { mtimeMs: entry.mtime, size: data.byteLength, sha256: "", excludeReason: contentReason, providerId: provider.id };
          result.excluded.push({ namespace, path, reason: contentReason }); continue;
        }
        resource.sha256 = await sha256Hex(data); resource.size = data.byteLength;
        hashCacheUpdates[entry.path] = { mtimeMs: entry.mtime, size: resource.size, sha256: resource.sha256, excludeReason: null, providerId: provider.id };
      }
      if (namespace === "portable-config") resource.entityId = await stableEntityId(ctx.bindingVaultId, path);
      result.entries.push(resource);
    }
    // Terminal tick for the walk, mirroring performAll()'s: the throttle's
    // trailing timer would deliver the last held-back tick anyway, but a run
    // that ends one entry short on screen is the exact frozen-at-96% bug the
    // progress work exists to remove, so it is stated rather than inferred.
    onProgress?.(walked, walked);
    if (Object.keys(hashCacheUpdates).length) { await host.hashCache?.upsertBatch(hashCacheUpdates); assertContext(); }
    // Only a complete scan is authoritative about which paths still exist —
    // reusing pruneMetadataEntries' precedent, pruning against a partial/capped
    // scan would delete cache rows for files the walk simply hasn't reached yet.
    if (scan.status === "complete") { await host.hashCache?.prune(scan.entries.filter(item => !item.isFolder).map(item => item.path)); assertContext(); }
    for (const doc of await host.portableConfig.project(scope)) {
      const initialDefault = await doc.isInitialDefault(); assertContext();
      result.entries.push({ namespace: "portable-config", path: doc.name, kind: "file", sha256: await sha256Hex(doc.data), size: doc.data.byteLength, entityId: await stableEntityId(ctx.bindingVaultId, doc.name), ...(initialDefault ? { initialDefault: true as const } : {}) });
    }
    const ancestors = new Set<string>();
    for (const resource of result.entries) { const parts = resource.path.split("/"); while (parts.pop() && parts.length) ancestors.add(`${resource.namespace}:${parts.join("/")}`); }
    for (const [key, folder] of folders) {
      if (ancestors.has(key) || included(folder.namespace, folder.path)) {
        if (folder.namespace === "portable-config") folder.entityId = await stableEntityId(ctx.bindingVaultId, folder.path);
        result.entries.push(folder);
      }
    }
    includedAncestors = ancestors;
    for (const resource of result.entries) if (resource.namespace === "content") {
      for (const [destination, source] of ctx.renameHints) if (resource.path === destination || resource.path.startsWith(destination + "/")) {
        resource.renamedFrom = source + resource.path.slice(destination.length);
        if (!scope.excludedFolders.some(folder => source === folder || source.startsWith(folder + "/"))) {
          const parents = resource.renamedFrom.split("/"); if (resource.kind !== "folder") parents.pop();
          while (parents.length) { ancestors.add(`content:${parents.join("/")}`); parents.pop(); }
        }
        break;
      }
    }
    assertContext(); return result;
  };
  const ports: HistoryControllerPorts = {
    load: async () => { const value = await host.deviceState.read(stateKey); assertContext(); return value; },
    save: async (value: HistoryControllerState) => { assertContext(); await host.deviceState.write(stateKey, value); assertContext(); },
    loadOperations: async () => await storage({ action: "load-operations" }) as HistoryOperation[],
    saveOperation: async value => { await storage({ action: "save-operation", key: value.id, value }); },
    stage: async (key, data) => await storage({ action: "stage", key, data }) as string,
    readStage: async key => await storage({ action: "read-stage", key }) as ArrayBuffer,
    release: async key => { await storage({ action: "release", key }); },
    snapshot, read, isIncluded: (namespace, path) => includedAncestors.has(`${namespace}:${path}`) || included(namespace, path),
    exclude: async (resource, data) => { const reason = resource.namespace === "content" ? await provider.excludePath?.(resource.path, data) : null; assertContext(); return reason ?? null; },
    apply: async (input: HistoryApply) => { assertContext(); await host.safety.apply(lease, { namespace: input.namespace, operationId: input.operationId, path: input.path, expectedHash: input.expectedHash, kind: input.deleted ? "trash" : input.kind === "folder" ? "mkdir" : "write", data: input.data }); assertContext(); if (input.namespace === "portable-config") await ctx.portableChanged(); assertContext(); },
    assertContext, newId: () => crypto.randomUUID(),
  };
  return { ports, storage };
}
