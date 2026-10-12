import type { GuardedMutation, GuardedMutationResult, SyncApplyOutcome, SyncSafetyService, SyncStorageRequest } from "../../shared/sync-safety";
import type { ConfigService } from "./contracts";
import { isPortableAssetPath } from "../../shared/portable-assets";
import { parsePortableConfig, projectPortableConfig, serializePortableConfig } from "../../shared/portable-config";
import { SyncBlockedError } from "../../sync-core/ports";
import { portableResourcePhysicalPath } from "../../sync-core/scope";
import { DEFAULT_SYNC_SCOPE } from "../sync/scope";

/**
 * Guarded sync apply and sync-private storage for a host with no Node filesystem (iOS). A port of
 * src/sync-node/sync-apply.ts and sync-private-storage.ts over a small set of native primitives
 * (`MobileSyncPorts`): the same hash guard, intent receipts, preimage recovery and crash-safe retry,
 * and the same storage vocabulary. Sync-private bytes live in the app sandbox, never in the vault tree,
 * so they are never scanned, listed, uploaded or synced.
 *
 * Differences from the desktop port, all forced by the platform:
 * - one webview owns the vault, so the owner lease is a token held in memory, scoped to the open vault;
 * - the native `writeBinary` already stages in the target's directory and swaps atomically with rollback, so
 *   there is no separate staging directory; deletions go through the vault's own native trash;
 * - the check-then-write window cannot be closed from JS; it is re-checked immediately before the
 *   mutation (as on desktop) and the native write is the only step left after it.
 */
export type NativeNodeKind = "none" | "file" | "folder" | "symlink";
export interface NativeStat { kind: NativeNodeKind; size: number; children: number; }
export interface MobileSyncPorts {
  /** Opaque identity of the open vault, or null when none is open. */
  rootId(): string | null;
  vault: {
    stat(path: string): Promise<NativeStat>;
    readBinary(path: string): Promise<ArrayBuffer>;
    writeBinary(path: string, data: ArrayBuffer, mutationId: string): Promise<void>;
    mkdir(path: string, mutationId: string): Promise<void>;
    trash(path: string, mutationId: string): Promise<void>;
  };
  /** App-sandbox storage, outside every vault. Paths are relative and `/`-separated. Writes are atomic and durable. */
  privateStore: {
    write(path: string, data: Uint8Array): Promise<void>;
    read(path: string): Promise<Uint8Array | null>;
    list(path: string): Promise<Array<{ name: string; isFolder: boolean }>>;
    remove(path: string, recursive: boolean): Promise<void>;
    availableBytes(): Promise<number | null>;
  };
  config: ConfigService;
}
export interface MobileSyncOptions {
  /** Test seam: called at named steps of an apply ("prepared" | "staged" | "committed" | "acknowledged"); throwing simulates a crash there. */
  checkpoint?(name: string): Promise<void> | void;
}

const MAX_BYTES = 100 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BINDING = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (data: ArrayBuffer | Uint8Array): Promise<string> => toHex(await crypto.subtle.digest("SHA-256", data as ArrayBuffer));
const copyBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);

/** Serialises async work per key (the single-process equivalent of withPathLock). */
class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }
}

/**
 * Free-space bookkeeping shared by every storage request of one safety service. Asking the native side for free space is a
 * bridge call, and doing it for every staged file of a thousand-file batch is a thousand calls for a number that barely moves.
 * An estimate (last measurement minus what this service staged since, never credited for what it freed) is trusted for a few
 * seconds while it still clears the requirement; the moment it would not, the real figure is measured again, so a refusal is
 * only ever issued on a fresh measurement.
 */
class CapacityTracker {
  private measured: number | null = null; private at = 0; private spent = 0;
  constructor(private readonly read: () => Promise<number | null>, private readonly maxAgeMs = 5000) {}
  async has(needed: number): Promise<boolean> {
    if (this.measured !== null && Date.now() - this.at < this.maxAgeMs && this.measured - this.spent >= needed) return true;
    const fresh = await this.read();
    if (fresh === null) return true;
    this.measured = fresh; this.at = Date.now(); this.spent = 0;
    return fresh >= needed;
  }
  staged(bytes: number): void { this.spent += bytes; }
}

/** Frozen bytes and one bounded journal per operation, for one binding of one vault. */
export class MobilePrivateStorage {
  constructor(private readonly store: MobileSyncPorts["privateStore"], private readonly dir: string, private readonly locks: KeyedLock,
    private readonly capacity: CapacityTracker = new CapacityTracker(() => store.availableBytes(), 0), private readonly bytesReleased: Set<string> = new Set()) {}
  private file(key: string, suffix: string): string {
    if (!UUID.test(key)) throw new Error("Invalid sync operation identity");
    return `${this.dir}/${key}${suffix}`;
  }
  async stage(key: string, bytes: ArrayBuffer): Promise<string> {
    // Resource-local, not systemic: the engine demotes just this file to "blocked" and the rest of the run goes on.
    if (bytes.byteLength > MAX_BYTES) throw new SyncBlockedError("too-large-for-mobile", "Sync file exceeds the 100 MiB limit");
    const target = this.file(key, ".blob");
    await this.locks.run(target, async () => {
      const prior = await this.store.read(target);
      const next = new Uint8Array(bytes);
      if (prior) { if (!sameBytes(prior, next)) throw new Error("Frozen sync bytes differ from retry content"); return; }
      if (!await this.capacity.has(bytes.byteLength * 2 + 4 * 1024 * 1024)) throw new Error("Insufficient disk space for frozen sync bytes and recovery headroom");
      try { await this.store.write(target, next); this.capacity.staged(next.byteLength); }
      catch (error) {
        // A native build without chunked storage cannot hold a file over its single-call limit: that is this file's problem, not the run's.
        if ((error as { code?: string } | null)?.code === "PAYLOAD_TOO_LARGE") throw new SyncBlockedError("too-large-for-mobile", "This iOS build cannot hold a file this large for sync");
        throw error;
      }
    });
    return key;
  }
  async readStage(key: string): Promise<ArrayBuffer> {
    const bytes = await this.store.read(this.file(key, ".blob"));
    if (!bytes) throw new Error("Frozen sync bytes are missing");
    if (bytes.byteLength > MAX_BYTES) throw new Error("Sync file exceeds 100 MiB limit");
    return copyBuffer(bytes);
  }
  async saveOperation(key: string, value: unknown): Promise<void> {
    const target = this.file(key, ".json"), bytes = encoder.encode(JSON.stringify(value));
    if (bytes.length > 1024 * 1024) throw new Error("Sync operation metadata exceeds limit");
    await this.locks.run(target, () => this.store.write(target, bytes));
  }
  /** `ids`: read only those journals (a recovering batch names exactly the ones it needs); a missing one is simply absent. */
  async loadOperations(ids?: readonly string[]): Promise<unknown[]> {
    const names = ids ? ids.map(id => `${id}.json`).sort() : (await this.store.list(this.dir)).filter(entry => !entry.isFolder && entry.name.endsWith(".json")).map(entry => entry.name).sort();
    const values: unknown[] = [];
    for (const name of names) {
      const bytes = await this.store.read(this.file(name.slice(0, -5), ".json"));
      if (bytes) values.push(JSON.parse(decoder.decode(bytes)));
    }
    return values;
  }
  async release(key: string): Promise<void> {
    // The blob is already gone if releaseBytes succeeded for this key; the terminal release then only needs the journal.
    const targets = [...this.bytesReleased.has(key) ? [] : [this.file(key, ".blob")], this.file(key, ".json")];
    for (const target of targets) await this.locks.run(target, () => this.store.remove(target, false));
    this.bytesReleased.delete(key);
  }
  /** Frozen bytes only; see SyncPrivateStorage.releaseBytes. */
  async releaseBytes(key: string): Promise<void> {
    const target = this.file(key, ".blob");
    await this.locks.run(target, () => this.store.remove(target, false));
    this.bytesReleased.add(key);
  }
  /** Startup GC: keep journals/blobs of 'prepared' operations and everything in `retain`; leave unparseable journals alone. */
  async gc(retain: readonly string[] = []): Promise<{ removed: number }> {
    const names = (await this.store.list(this.dir)).filter(entry => !entry.isFolder).map(entry => entry.name);
    const keep = new Set(retain);
    for (const name of names) if (name.endsWith(".json")) {
      const key = name.slice(0, -5);
      // A journal the caller says to keep is kept whatever its phase, so reading it would only cost a bridge call
      // (a recovering batch of thousands retains every one of its journals).
      if (keep.has(key)) continue;
      try {
        const bytes = await this.store.read(`${this.dir}/${name}`);
        const value = bytes ? JSON.parse(decoder.decode(bytes)) as { phase?: unknown; payload?: { key?: unknown } } : null;
        if (value?.phase === "prepared") { keep.add(key); if (typeof value.payload?.key === "string") keep.add(value.payload.key); }
      } catch { keep.add(key); }
    }
    let removed = 0;
    for (const name of names) {
      const full = `${this.dir}/${name}`;
      if (name.endsWith(".tmp")) { await this.store.remove(full, false); removed++; continue; }
      const match = /^(.+)\.(blob|json)$/.exec(name);
      if (!match || keep.has(match[1])) continue;
      await this.locks.run(full, () => this.store.remove(full, false)); removed++;
    }
    return { removed };
  }
}

/** Removes binding directories of one vault: all of them on `force` (disconnect), otherwise those not in `keep` that hold no 'prepared' journal. */
async function sweepBindings(store: MobileSyncPorts["privateStore"], vaultDir: string, keep: readonly string[], force: boolean): Promise<{ removed: string[]; skipped: string[] }> {
  const removed: string[] = [], skipped: string[] = [];
  for (const entry of await store.list(vaultDir)) {
    if (!entry.isFolder || !BINDING.test(entry.name) || (!force && keep.includes(entry.name))) continue;
    const dir = `${vaultDir}/${entry.name}`;
    if (!force) {
      let prepared = false;
      for (const file of (await store.list(dir)).filter(item => item.name.endsWith(".json"))) {
        try { const bytes = await store.read(`${dir}/${file.name}`); if (bytes && JSON.parse(decoder.decode(bytes))?.phase === "prepared") prepared = true; } catch { prepared = true; }
      }
      if (prepared) { skipped.push(entry.name); continue; }
    }
    await store.remove(dir, true); removed.push(entry.name);
  }
  return { removed, skipped };
}

interface Receipt { path: string; expectedHash: string | null; desiredHash: string | null; kind: GuardedMutation["kind"]; state: "prepared" | "applied"; }
interface Snapshot { hash: string | null; bytes?: ArrayBuffer; children?: number; }

export function createMobileSyncSafety(ports: MobileSyncPorts, options: MobileSyncOptions = {}): SyncSafetyService {
  const locks = new KeyedLock();
  const capacity = new CapacityTracker(() => ports.privateStore.availableBytes()), bytesReleased = new Set<string>();
  let owner: { root: string; token: string } | null = null;
  const prepareHandlers = new Set<(token: string, path: string) => Promise<string | null>>();
  const releaseHandlers = new Set<(token: string, outcome?: SyncApplyOutcome) => Promise<void>>();

  const currentOwner = (token: string): string => {
    const root = ports.rootId();
    if (!root || !owner || owner.root !== root || owner.token !== token) throw new Error("Sync ownership changed");
    return root;
  };
  const vaultDirectory = async (root: string) => `${(await sha256Hex(encoder.encode(root)))}`;

  async function storage(token: string, binding: string, request: SyncStorageRequest): Promise<unknown> {
    const root = currentOwner(token);
    if (typeof binding !== "string" || !BINDING.test(binding)) throw new Error("Invalid sync storage binding");
    const vaultDir = await vaultDirectory(root);
    const bindingStore = new MobilePrivateStorage(ports.privateStore, `${vaultDir}/${binding}`, locks, capacity, bytesReleased);
    let result: unknown;
    switch (request.action) {
      case "stage": result = await bindingStore.stage(request.key, request.data); break;
      case "read-stage": result = await bindingStore.readStage(request.key); break;
      case "save-operation": result = await bindingStore.saveOperation(request.key, request.value); break;
      case "load-operations": result = await bindingStore.loadOperations(Array.isArray(request.ids) ? request.ids : undefined); break;
      case "release": result = await bindingStore.release(request.key); break;
      case "release-bytes": result = await bindingStore.releaseBytes(request.key); break;
      case "gc": if (!Array.isArray(request.retain) || request.retain.some(id => typeof id !== "string")) throw new Error("Invalid sync storage request"); result = await bindingStore.gc(request.retain); break;
      case "sweep": if (!Array.isArray(request.keep) || request.keep.some(id => typeof id !== "string")) throw new Error("Invalid sync storage request"); result = await sweepBindings(ports.privateStore, vaultDir, request.keep, request.force === true); break;
      default: throw new Error("Invalid sync storage request");
    }
    currentOwner(token);
    return result;
  }

  const checkSegments = (relative: string, portable: boolean): string[] => {
    const segments = relative.split("/");
    if (!relative || relative.includes("\\") || relative.includes("\0") || relative.normalize("NFC") !== relative || segments.some((segment, index) => !segment || segment === "." || segment === ".." || segment.startsWith(".") && !(portable && index === 0 && (segment === ".geode" || segment === ".obsidian")))) throw new Error("Unsafe sync path");
    return segments;
  };
  const FOLDER: NativeStat = { kind: "folder", size: 0, children: 0 };

  /**
   * Same rules as the desktop path check; additionally every existing ancestor must be a real directory, never a link.
   * The native `stat` already reports "symlink" when a link sits on ANY component of the path, and "none" when a component is
   * missing or is not a directory. So one stat of the full path answers for every ancestor of an existing target, and for a
   * missing target only the nearest existing ancestor needs looking up (two stats for a new file in an existing folder,
   * instead of one per segment).
   */
  async function checkPath(relative: string, portable: boolean): Promise<{ stats: NativeStat[] }> {
    const segments = checkSegments(relative, portable), last = segments.length - 1;
    const at = (index: number) => ports.vault.stat(segments.slice(0, index + 1).join("/"));
    const target = await at(last);
    if (target.kind === "symlink") throw new Error("Sync cannot traverse symbolic links");
    const stats: NativeStat[] = new Array(segments.length).fill(null).map(() => ({ kind: "none", size: 0, children: 0 }) as NativeStat);
    stats[last] = target;
    if (target.kind !== "none") { for (let index = 0; index < last; index++) stats[index] = FOLDER; return { stats }; }
    for (let index = last - 1; index >= 0; index--) {
      const stat = await at(index);
      if (stat.kind === "symlink") throw new Error("Sync cannot traverse symbolic links");
      if (stat.kind === "file") throw new Error("Sync parent is not a directory");
      stats[index] = stat;
      if (stat.kind === "folder") { for (let above = 0; above < index; above++) stats[above] = FOLDER; break; }
    }
    return { stats };
  }
  /**
   * The re-check immediately before the mutation: only the target, because that single stat is what the hash guard compares and
   * it already fails closed on a link anywhere on the path. An ancestor that vanished or became a file since checkPath makes the
   * native write fail (nothing is written), which the engine retries.
   */
  async function recheckTarget(relative: string): Promise<NativeStat> {
    const stat = await ports.vault.stat(relative);
    if (stat.kind === "symlink") throw new Error("Sync cannot traverse symbolic links");
    return stat;
  }

  async function snapshot(relative: string, stat: NativeStat): Promise<Snapshot> {
    if (stat.kind === "none") return { hash: null };
    if (stat.kind === "symlink") throw new Error("Sync cannot apply to symbolic links");
    if (stat.kind === "folder") return { hash: "folder", children: stat.children };
    if (stat.size > MAX_BYTES) throw new Error("File exceeds 100 MiB or is unsupported");
    const bytes = await ports.vault.readBinary(relative);
    if (bytes.byteLength > MAX_BYTES) throw new Error("File exceeds 100 MiB");
    return { hash: await sha256Hex(bytes), bytes };
  }

  async function ensureParents(relative: string, stats: NativeStat[], mutationId: string): Promise<void> {
    const segments = relative.split("/");
    for (let index = 0; index < segments.length - 1; index++) {
      if (stats[index].kind === "none") await ports.vault.mkdir(segments.slice(0, index + 1).join("/"), mutationId);
      else if (stats[index].kind !== "folder") throw new Error("Sync parent is not a directory");
    }
  }

  async function applyVaultMutation(root: string, ownerToken: string, input: GuardedMutation): Promise<GuardedMutationResult> {
    const portable = input.namespace === "portable-config";
    const physicalPath = portable ? portableResourcePhysicalPath(input.path) : input.path;
    const receiptIdentity = `${input.namespace ?? "content"}:${input.path}`;
    const walked = await checkPath(physicalPath, portable);
    const desiredHash = input.kind === "write" ? await sha256Hex(input.data!) : input.kind === "mkdir" ? "folder" : null;
    const recoveryPath = `${await vaultDirectory(root)}/recovery/${input.operationId}`;
    const receiptFile = `${recoveryPath}/intent.json`;
    return locks.run(`apply:${root}`, async () => {
      currentOwner(ownerToken);
      let receipt: Receipt | null = await ports.privateStore.read(receiptFile).then(bytes => bytes ? JSON.parse(decoder.decode(bytes)) as Receipt : null);
      const current = await snapshot(physicalPath, walked.stats[walked.stats.length - 1]);
      const writeReceipt = (value: Receipt) => ports.privateStore.write(receiptFile, encoder.encode(JSON.stringify(value)));
      if (receipt) {
        if (receipt.path !== receiptIdentity || receipt.desiredHash !== desiredHash || receipt.expectedHash !== input.expectedHash || receipt.kind !== input.kind) throw new Error("Sync operation identity was reused with different content");
        if (current.hash === desiredHash) { receipt.state = "applied"; await writeReceipt(receipt); return { status: "already-applied", hash: desiredHash, recoveryPath }; }
        if (receipt.state === "applied") throw new Error("Local file changed after sync application");
      }
      if (current.hash !== input.expectedHash) throw new Error("Local file changed before sync application");
      if (current.hash === "folder" && (input.kind !== "trash" || current.children)) throw new Error("Sync cannot replace a folder or delete live descendants");
      if (!receipt) {
        if (current.bytes) await ports.privateStore.write(`${recoveryPath}/before`, new Uint8Array(current.bytes));
        receipt = { path: receiptIdentity, expectedHash: input.expectedHash, desiredHash, kind: input.kind, state: "prepared" };
        await writeReceipt(receipt);
      }
      await options.checkpoint?.("prepared"); currentOwner(ownerToken);
      if (input.kind === "write") await ensureParents(physicalPath, walked.stats, input.operationId);
      await options.checkpoint?.("staged");
      const latest = await snapshot(physicalPath, await recheckTarget(physicalPath));
      if (latest.hash !== input.expectedHash) throw new Error("Local file changed while sync prepared recovery");
      if (current.hash === "folder" && latest.children) throw new Error("Folder acquired live descendants");
      currentOwner(ownerToken);
      if (input.kind === "write") await ports.vault.writeBinary(physicalPath, input.data!, input.operationId);
      else if (input.kind === "mkdir") await ports.vault.mkdir(physicalPath, input.operationId);
      else if (current.hash !== null) await ports.vault.trash(physicalPath, input.operationId);
      await options.checkpoint?.("committed"); currentOwner(ownerToken);
      receipt.state = "applied"; await writeReceipt(receipt);
      await options.checkpoint?.("acknowledged");
      return { status: "applied", hash: desiredHash, recoveryPath };
    });
  }

  /** Portable settings documents live in host config, not as vault files; same guard and receipt, different target. */
  async function applyPortableConfig(root: string, ownerToken: string, input: GuardedMutation): Promise<GuardedMutationResult> {
    if (input.kind !== "write" || !input.data) throw new Error("Invalid portable configuration mutation");
    const document = parsePortableConfig(input.path, input.data);
    const desiredHash = await sha256Hex(serializePortableConfig(document));
    const source = document.name === "hotkeys.json" ? "hotkeys" : document.name === "daily-notes.json" ? "daily-notes" : "app";
    const recoveryPath = `${await vaultDirectory(root)}/recovery/${input.operationId}`;
    const receiptFile = `${recoveryPath}/intent.json`;
    return locks.run(`apply:${root}`, async () => {
      currentOwner(ownerToken);
      const read = async (): Promise<Record<string, unknown>> => {
        const value = await ports.config.read(source);
        if (value === null || value === undefined) return {};
        if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local configuration");
        return value as Record<string, unknown>;
      };
      const category = async (raw: Record<string, unknown>) => serializePortableConfig((await projectPortableConfig({ read: async () => raw }, {
        ...DEFAULT_SYNC_SCOPE, mainSettings: document.name === "editor.json", appearance: document.name === "appearance.json", hotkeys: document.name === "hotkeys.json", corePlugins: document.name === "daily-notes.json",
      }))[0]);
      const before = await category(await read());
      const beforeHash = await sha256Hex(before);
      const receipt = await ports.privateStore.read(receiptFile).then(bytes => bytes ? JSON.parse(decoder.decode(bytes)) as { category: string; expectedHash: string | null; desiredHash: string; state: string } : null);
      if (receipt && (receipt.category !== input.path || receipt.expectedHash !== input.expectedHash || receipt.desiredHash !== desiredHash)) throw new Error("Portable operation identity was reused");
      if (receipt && beforeHash === desiredHash) return { status: "already-applied", hash: desiredHash, recoveryPath };
      if (beforeHash !== input.expectedHash || receipt?.state === "applied") throw new Error("Portable settings changed before application");
      const intent = { category: input.path, expectedHash: input.expectedHash, desiredHash, state: "prepared" };
      if (!receipt) { await ports.privateStore.write(`${recoveryPath}/before`, new Uint8Array(before)); await ports.privateStore.write(receiptFile, encoder.encode(JSON.stringify(intent))); }
      const latest = await read();
      if (await sha256Hex(await category(latest)) !== input.expectedHash) throw new Error("Portable settings changed while preparing recovery");
      currentOwner(ownerToken);
      await ports.config.write(source, { ...latest, ...document.value });
      await ports.privateStore.write(receiptFile, encoder.encode(JSON.stringify({ ...intent, state: "applied" })));
      return { status: "applied", hash: desiredHash, recoveryPath };
    });
  }

  async function apply(token: string, input: GuardedMutation): Promise<GuardedMutationResult> {
    const root = currentOwner(token);
    if (!UUID.test(input.operationId ?? "")) throw new Error("Invalid sync operation identity");
    if (!["write", "trash", "mkdir"].includes(input.kind)) throw new Error("Invalid sync mutation");
    if (input.kind === "write" && !(input.data instanceof ArrayBuffer)) throw new Error("Sync write bytes required");
    if (input.data && input.data.byteLength > MAX_BYTES) throw new Error("File exceeds 100 MiB");
    const portable = input.namespace === "portable-config";
    // Settings documents (editor.json, ...) are host configuration, not files (the desktop routes them the same way); assets are vault files under .geode/.
    const isDocument = portable && !isPortableAssetPath(input.path);
    return locks.run(`guard:${root}`, async () => {
      currentOwner(token);
      // One webview, so one participant: the editor guard is the same prepare/release handshake the desktop runs per window.
      const guard = crypto.randomUUID();
      let result: GuardedMutationResult | undefined, failure: unknown;
      try {
        const reasons = await Promise.all([...prepareHandlers].map(handler => handler(guard, input.path)));
        const blocked = reasons.find(reason => reason !== null && reason !== undefined); if (blocked) throw new Error(blocked);
        currentOwner(token);
        result = await (isDocument ? applyPortableConfig(root, token, input) : applyVaultMutation(root, token, input));
      } catch (error) { failure = error; }
      finally {
        const outcome: SyncApplyOutcome = { namespace: portable ? "portable-config" : "content", path: input.path, kind: input.kind, ...(input.data ? { size: input.data.byteLength } : {}), changed: result !== undefined };
        const releases = await Promise.all([...releaseHandlers].map(handler => handler(guard, outcome).then(() => null, (error: unknown) => error)));
        if (!failure && releases.some(reason => reason !== null)) failure = new Error("Editor refresh incomplete; sync can retry safely");
      }
      if (failure) throw failure;
      return result!;
    });
  }

  return {
    storage,
    async claimOwner() {
      const root = ports.rootId();
      if (!root) throw new Error("No vault open");
      if (owner?.root === root) return owner.token;
      owner = { root, token: crypto.randomUUID() };
      return owner.token;
    },
    async releaseOwner(token) { if (owner?.token === token) owner = null; },
    apply,
    onPrepare(handler) { prepareHandlers.add(handler); return () => { prepareHandlers.delete(handler); }; },
    onRelease(handler) { releaseHandlers.add(handler); return () => { releaseHandlers.delete(handler); }; },
  };
}
