import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { SyncBlockedError, type SyncHostLite, type SyncVaultScan } from "../sync-core/ports";
import type { GuardedMutation, GuardedMutationResult, SyncStorageRequest } from "../shared/sync-safety";
import { applyGuardedMutation, durableWrite, ensureDurableDirectory } from "./sync-apply";
import { SyncPrivateStorage } from "./sync-private-storage";
import { withStoreLock } from "./store-lock";
import { isStoreError } from "./store-errors";
import { NodeHashCache } from "./node-hash-cache";
import { hydrateIcloudPaths, type HydrateOptions, type HydrateReport } from "./node-icloud";
import { ICLOUD_EVICTED, ICLOUD_NOT_DOWNLOADED, scanVault, type ScanIo, type ScanReport } from "./node-scan";

/**
 * A Node implementation of SyncHostLite: everything the append-only history engine
 * needs to sync a plain directory with no Electron around it.
 *
 * Layout of the device state directory (default `~/.geode/sync/<vaultId>/`, base
 * overridable with GEODE_SYNC_HOME or the `stateDir` option; always OUTSIDE the vault):
 *   state.json        controller state, durably written
 *   ops/<binding>/    per-operation journals + frozen bytes (SyncPrivateStorage)
 *   hash-cache.json   (path,size,mtime,providerId) -> sha256
 *   trash/            files removed or overwritten by sync (<operationId>/<path>)
 *   recovery/         pre-image + receipt per guarded mutation
 *   lock/             cross-process mutex (mkdir + owner.json{pid,bootId})
 */

export const DEFAULT_STAGING_DIRNAME = ".geode-sync-tmp";

/** Another process (a timer run, a manual run) holds the state-dir lock. */
export class SyncLockedError extends Error {
  readonly code = "locked";
  constructor(readonly stateDir: string) { super(`Another sync run holds the lock for ${stateDir}`); this.name = "SyncLockedError"; }
}
export class SyncStateDirError extends Error {
  readonly code = "state-dir-invalid";
  constructor(message: string) { super(message); this.name = "SyncStateDirError"; }
}

export interface NodeHostOptions {
  /** The vault directory. */
  root: string;
  /** Identifies the vault; names the default state dir. Required unless `stateDir` is given. */
  vaultId?: string;
  /** Explicit device state directory. Must resolve outside the vault. */
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Vault-relative folders to leave out (e.g. the CLI's --exclude). */
  excludeFolders?: readonly string[];
  /** Defer files modified within this window ("unsettled"). Default 5000; 0 disables. */
  settleMs?: number;
  scanConcurrency?: number;
  /** Heuristic for evicted-but-named iCloud files (`blocks === 0 && size > 0`). Default: darwin only. */
  detectEvicted?: boolean;
  /**
   * Where apply writes its temp file before the atomic rename. Default
   * `<vault>/.geode-sync-tmp`: it must share a volume with the target for the rename
   * to be atomic, and a dotted directory is skipped by the scan and is a reserved
   * path in the sync scope, so it is never published as content. iCloud note: if the
   * vault lives in iCloud Drive, files here are transient (they exist for the length
   * of one write+rename and the directory is emptied under the lock at the start of
   * every run), and an upload of one is harmless noise; we do not rely on iCloud
   * ignoring dotted items. Pass `null` to stage beside each target instead (also
   * the automatic fallback when the directory is on a different device).
   */
  stagingDir?: string | null;
  /** Opt in to `brctl download` for blocked iCloud files. Default false: never hydrate. */
  hydrateIcloud?: boolean;
  hydrate?: Omit<HydrateOptions, "signal">;
  /** Fires at each apply checkpoint (prepared/staged/committed/acknowledged). Throwing aborts the apply: crash-injection seam. */
  applyCheckpoint?: (name: string, mutation: GuardedMutation) => Promise<void> | void;
  scanIo?: ScanIo;
  now?: () => number;
}

const HEX64 = /^[a-f0-9]{64}$/;
const MAX_READ = 100 * 1024 * 1024;

/** realpath of the deepest existing ancestor, with the not-yet-created tail re-appended. */
async function resolveEventual(target: string): Promise<string> {
  const tail: string[] = []; let current = path.resolve(target);
  for (;;) {
    try { return path.join(await fs.realpath(current), ...tail.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current); if (parent === current) throw error;
      tail.push(path.basename(current)); current = parent;
    }
  }
}

export function defaultStateDir(vaultId: string, env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(vaultId)) throw new SyncStateDirError(`Invalid vault id for a state directory: ${vaultId}`);
  return path.join(env.GEODE_SYNC_HOME ? path.resolve(env.GEODE_SYNC_HOME) : path.join(homeDir, ".geode", "sync"), vaultId);
}

/** Throws unless `stateDir` is disjoint from the vault (neither inside the other). */
export async function assertStateDirOutsideVault(root: string, stateDir: string): Promise<{ root: string; stateDir: string }> {
  const realRoot = await fs.realpath(root), realState = await resolveEventual(stateDir);
  const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  if (inside(realState, realRoot)) throw new SyncStateDirError(`Sync state directory ${realState} is inside the vault ${realRoot}; sync state must never live in (or be synced with) the vault`);
  if (inside(realRoot, realState)) throw new SyncStateDirError(`Vault ${realRoot} is inside the sync state directory ${realState}`);
  return { root: realRoot, stateDir: realState };
}

interface DeviceStateFile { schema: 1; values: Record<string, unknown>; }

export class NodeHost implements SyncHostLite {
  readonly root: string;
  readonly stateDir: string;
  readonly stagingDir: string | null;
  /** What the last reconcileScan saw, including blocked/excluded rows and unreadable directories. */
  lastScan: ScanReport | null = null;
  lastHydration: HydrateReport | null = null;
  private lease: string | null = null;
  private deviceValues: Record<string, unknown> | null = null;
  private stateChain: Promise<unknown> = Promise.resolve();
  private readonly cache: NodeHashCache;
  private static readonly held = new Set<string>();

  private constructor(private readonly options: NodeHostOptions, root: string, stateDir: string) {
    this.root = root; this.stateDir = stateDir;
    this.cache = new NodeHashCache(path.join(stateDir, "hash-cache.json"));
    this.stagingDir = options.stagingDir === null ? null : path.resolve(options.stagingDir ?? path.join(root, DEFAULT_STAGING_DIRNAME));
  }

  static async open(options: NodeHostOptions): Promise<NodeHost> {
    const configured = options.stateDir ?? (options.vaultId ? defaultStateDir(options.vaultId, options.env, options.homeDir) : undefined);
    if (!configured) throw new SyncStateDirError("Either vaultId or stateDir is required");
    const resolved = await assertStateDirOutsideVault(options.root, configured);
    return new NodeHost(options, resolved.root, resolved.stateDir);
  }

  /**
   * Runs `fn` holding the cross-process lock. Rejects with SyncLockedError (the
   * CLI's exit 5) if a timer run or manual run already holds it. Inside, the
   * `lease` is the token the engine must present to storage/apply.
   */
  async run<T>(fn: (lease: string) => Promise<T>, signal: AbortSignal = new AbortController().signal): Promise<T> {
    if (NodeHost.held.has(this.stateDir)) throw new SyncLockedError(this.stateDir);
    NodeHost.held.add(this.stateDir);
    try {
      await ensureDurableDirectory(this.stateDir);
      try {
        return await withStoreLock(this.stateDir, signal, async () => {
          const lease = randomUUID(); this.lease = lease;
          try {
            await this.sweepStaging();
            return await fn(lease);
          } finally { this.lease = null; await this.cache.flush().catch(() => {}); }
        }, 0, "lock");
      } catch (error) {
        if (isStoreError(error) && error.code === "lock-timeout") throw new SyncLockedError(this.stateDir);
        throw error;
      }
    } finally { NodeHost.held.delete(this.stateDir); }
  }

  /** Orphaned staging temp files can only belong to a dead run, because we hold the lock. */
  private async sweepStaging(): Promise<void> {
    if (!this.stagingDir) return;
    for (const name of await fs.readdir(this.stagingDir).catch(() => [] as string[])) await fs.rm(path.join(this.stagingDir, name), { recursive: true, force: true }).catch(() => {});
  }

  private requireLease(token: string): void { if (!this.lease || token !== this.lease) throw new Error("Sync ownership changed"); }

  private async values(): Promise<Record<string, unknown>> {
    if (this.deviceValues) return this.deviceValues;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.stateDir, "state.json"), "utf8")) as DeviceStateFile;
      this.deviceValues = parsed?.schema === 1 && parsed.values && typeof parsed.values === "object" ? parsed.values : {};
    } catch (error) {
      // A missing file is a fresh device; an unreadable one is not: guessing "fresh" could re-adopt a vault and hide deletions.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Sync state file is unreadable: ${(error as Error).message}`);
      this.deviceValues = {};
    }
    return this.deviceValues;
  }

  readonly vault: SyncHostLite["vault"] = {
    reconcileScan: async (): Promise<SyncVaultScan> => {
      const scan = () => scanVault({ root: this.root, excludeFolders: this.options.excludeFolders, settleMs: this.options.settleMs, concurrency: this.options.scanConcurrency, detectEvicted: this.options.detectEvicted, io: this.options.scanIo, now: this.options.now });
      let report = await scan();
      this.lastHydration = null;
      if (this.options.hydrateIcloud && report.blocked?.some(item => item.reason === ICLOUD_NOT_DOWNLOADED || item.reason === ICLOUD_EVICTED)) {
        this.lastHydration = await hydrateIcloudPaths(this.root, report.blocked, this.options.hydrate);
        if (this.lastHydration.hydrated.length) report = await scan();
      }
      this.lastScan = report;
      return report;
    },
    readBinary: async (relative: string): Promise<ArrayBuffer> => {
      if (!relative || relative.includes("\0") || path.isAbsolute(relative) || relative.split("/").some(part => part === ".." || part === "")) throw new Error("Unsafe sync path");
      const absolute = path.join(this.root, relative);
      const stat = await fs.lstat(absolute).catch(async (error: NodeJS.ErrnoException) => {
        // The name is gone but a placeholder stands in for it: not deleted, just not downloaded.
        if (error.code === "ENOENT" && await fs.lstat(path.join(path.dirname(absolute), `.${path.basename(absolute)}.icloud`)).then(() => true, () => false)) throw new SyncBlockedError(ICLOUD_NOT_DOWNLOADED);
        throw error;
      });
      if (stat.isSymbolicLink()) throw new SyncBlockedError("symlink");
      if (!stat.isFile()) throw new Error("Not a regular file");
      if (stat.size > MAX_READ) throw new Error("File exceeds 100 MiB");
      if ((this.options.detectEvicted ?? process.platform === "darwin") && stat.blocks === 0 && stat.size > 0) throw new SyncBlockedError(ICLOUD_EVICTED);
      try {
        const bytes = await fs.readFile(absolute);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      } catch (error) {
        // Dataless faults surface as these errno values when materialisation is refused or times out: retry later, never fail the run.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EDEADLK" || code === "ETIMEDOUT") throw new SyncBlockedError(ICLOUD_EVICTED, (error as Error).message);
        if (code === "EAGAIN" || code === "EBUSY") throw new SyncBlockedError("read-busy", (error as Error).message);
        throw error;
      }
    },
  };

  readonly hashCache: NonNullable<SyncHostLite["hashCache"]> = {
    readAll: () => this.cache.readAll(),
    upsertBatch: entries => this.cache.upsertBatch(entries),
    prune: keep => this.cache.prune(keep),
  };

  readonly deviceState: SyncHostLite["deviceState"] = {
    read: async <T>(key: string): Promise<T | null> => { const values = await this.values(); return key in values ? structuredClone(values[key]) as T : null; },
    write: async (key: string, value: unknown): Promise<void> => {
      const run = this.stateChain.then(async () => {
        const values = await this.values(); const next = { ...values, [key]: structuredClone(value) };
        await ensureDurableDirectory(this.stateDir);
        await durableWrite(path.join(this.stateDir, "state.json"), Buffer.from(JSON.stringify({ schema: 1, values: next } satisfies DeviceStateFile)));
        this.deviceValues = next;
      });
      this.stateChain = run.catch(() => {}); await run;
    },
  };

  readonly safety: SyncHostLite["safety"] = {
    storage: async (token: string, binding: string, request: SyncStorageRequest): Promise<unknown> => {
      this.requireLease(token);
      if (typeof binding !== "string" || !HEX64.test(binding)) throw new Error("Invalid sync storage binding");
      const opsRoot = path.join(this.stateDir, "ops"), storage = new SyncPrivateStorage(path.join(opsRoot, binding));
      switch (request.action) {
        case "stage": return storage.stage(request.key, request.data);
        case "read-stage": return storage.readStage(request.key);
        case "save-operation": return storage.saveOperation(request.key, request.value);
        case "load-operations": return storage.loadOperations();
        case "release": return storage.release(request.key);
        case "gc": if (!Array.isArray(request.retain) || request.retain.some(id => typeof id !== "string")) throw new Error("Invalid sync storage request"); return storage.gc(request.retain);
        case "sweep": if (!Array.isArray(request.keep) || request.keep.some(id => typeof id !== "string")) throw new Error("Invalid sync storage request"); return SyncPrivateStorage.sweepBindings(opsRoot, request.keep, request.force === true);
        default: throw new Error("Invalid sync storage request");
      }
    },
    apply: async (token: string, input: GuardedMutation): Promise<GuardedMutationResult> => {
      this.requireLease(token);
      const hook = this.options.applyCheckpoint;
      return applyGuardedMutation(this.root, path.join(this.stateDir, "recovery"), input, {
        trashDir: path.join(this.stateDir, "trash"),
        ...(this.stagingDir ? { stagingDir: this.stagingDir } : {}),
        assertContext: () => this.requireLease(token),
        ...(hook ? { checkpoint: async (name: string) => { await hook(name, input); } } : {}),
      });
    },
  };

  /** Headless has no app configuration to project (settings, themes, hotkeys): content sync only. */
  readonly portableConfig: SyncHostLite["portableConfig"] = { project: async () => [] };
}
