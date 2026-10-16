/**
 * Geode sync provider for iCloud (`conditional-mutation-v1`), written once against the platform bridge
 * (ADR 0030). This is the PR #381 provider's policy, byte-compatible on the remote (path ids, `mtime:size:sha256`
 * revisions, `.geode-sync/marker.json`, `.geode-sync/ops/`, `.geode-trash/`), with its Node `fs`/`brctl` calls
 * replaced by the bridge's primitives. Electron backs the bridge with Node `fs` over IPC; iOS will back it with
 * `NSFileCoordinator`. No platform code and no Node imports here.
 *
 * Fail closed everywhere: an unavailable container is `unavailable`, never an empty snapshot; an evicted file
 * or a conflict copy makes the scan `partial`; a stale revision is a `SyncPreconditionError`.
 */
import {
  FOLDER_REVISION,
  IcloudBridgeError,
  type IcloudContainerBridge,
  type IcloudStat,
  type IcloudWritePrecondition,
} from "../../../shared/icloud-container";
import type { SyncProvider, SyncProviderCapabilities, SyncRemoteEntry, SyncScanResult, SyncSession, SyncWriteInput } from "../../sync/types";
import { SyncPreconditionError } from "../../sync/types";
import { isJunkName, MARKER_FILE, OPS_DIR, resolveFolderName, STATE_DIR, TMP_PREFIX, TRASH_DIR, WALK_SKIP } from "./folders";

export { TRASH_DIR, STATE_DIR, vaultFolderName } from "./folders";
export const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;
/** Payload per bridge call. Bounded so no single IPC/Capacitor message carries a huge base64 body. */
export const TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;

/** Errors scans report through `SyncScanResult.errorCode`. */
export const ErrorCodes = {
  unavailable: "icloud-unavailable",
  placeholders: "icloud-placeholders-unresolved",
  conflictCopies: "icloud-conflict-copies",
  markerMissing: "icloud-marker-missing",
  unreadable: "icloud-unreadable",
  symlink: "icloud-unsupported-symlink",
} as const;

export interface IcloudDiagnostics {
  /** Evicted files that could not be downloaded in time (vault-relative real names). */
  unresolvedPlaceholders: string[];
  /** Files that look like iCloud conflict copies and were withheld from the scan. */
  conflictCopies: Array<{ path: string; original: string }>;
  /** Other reasons the last scan was not complete (including why the container was unavailable). */
  problems: string[];
}

export interface IcloudProviderOptions {
  bridge: IcloudContainerBridge;
  maxFileSize?: number;
  /** How long a scan waits for requested downloads before reporting `partial`. */
  placeholderWaitMs?: number;
  placeholderPollMs?: number;
  onDiagnostics?: (vaultId: string, diagnostics: IcloudDiagnostics) => void;
  /** The remote folder the user chose for this vault, if any. See `resolveFolderName` for the fallback. */
  chosenFolder?: (vaultId: string) => string | undefined | Promise<string | undefined>;
}

export const ICLOUD_CAPABILITIES = {
  binary: true,
  conditionalWrites: true,
  delta: false,
  completeSnapshots: true,
  atomicMoves: true,
  trash: true,
} as const;

export function createIcloudProvider(options: IcloudProviderOptions): SyncProvider {
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const capabilities: SyncProviderCapabilities = { ...ICLOUD_CAPABILITIES, maxFileSize };
  return {
    protocol: "conditional-mutation-v1",
    id: "icloud",
    name: "iCloud",
    capabilities,
    async open({ vaultId }) {
      const folder = await resolveFolderName(vaultId, await options.chosenFolder?.(vaultId));
      return new IcloudSession(vaultId, folder, options, maxFileSize);
    },
  };
}

/** The real file name behind a `.name.icloud` placeholder, or null if `name` is not one. */
export function realNameOfPlaceholder(name: string): string | null {
  if (name.length > ".x.icloud".length - 1 && name.startsWith(".") && name.endsWith(".icloud")) return name.slice(1, -".icloud".length);
  return null;
}

const CONFLICT_NAME = /^(.*\S) (\d+)(\.[^./]+)?$/;

/** For `Note 2.md` returns `Note.md`: the name iCloud's conflict copy would have been made from. Null if the name is not conflict-shaped. */
export function conflictOriginalName(name: string): string | null {
  const m = CONFLICT_NAME.exec(name);
  return m ? `${m[1]}${m[3] ?? ""}` : null;
}

interface OpRecord {
  path: string;
  sha256: string;
  committed: boolean;
}

interface WalkResult {
  entries: SyncRemoteEntry[];
  placeholders: string[];
  conflictCopies: Array<{ path: string; original: string }>;
  problems: string[];
  problemCode?: string;
}

class IcloudSession implements SyncSession {
  private closed = false;
  private readonly active = new Set<AbortController>();

  constructor(private readonly vaultId: string, private readonly folder: string, private readonly options: IcloudProviderOptions, private readonly maxFileSize: number) {}

  /** Test seam: the resolved remote folder name. */
  get remoteFolder(): string {
    return this.folder;
  }

  private get bridge(): IcloudContainerBridge {
    return this.options.bridge;
  }

  // --- lifecycle ----------------------------------------------------------

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("iCloud sync session is closed");
  }

  /** Combine the caller's signal with session close so `close()` interrupts in-flight work; map bridge errors to the host's. */
  private async withSignal<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertOpen();
    throwIfAborted(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    this.active.add(controller);
    try {
      return await run(controller.signal);
    } catch (error) {
      throw hostError(error);
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.active.delete(controller);
    }
  }

  // --- scan ---------------------------------------------------------------

  async scan(_cursor: string | undefined, signal: AbortSignal): Promise<SyncScanResult> {
    try {
      return await this.withSignal(signal, (s) => this.scanInner(s));
    } catch (error) {
      if (isAbort(error) || signal.aborted) return { status: "cancelled", entries: [] };
      throw error;
    }
  }

  private async scanInner(signal: AbortSignal): Promise<SyncScanResult> {
    const diagnostics: IcloudDiagnostics = { unresolvedPlaceholders: [], conflictCopies: [], problems: [] };
    const report = (result: SyncScanResult): SyncScanResult => {
      this.options.onDiagnostics?.(this.vaultId, diagnostics);
      return result;
    };
    try {
      return await this.scanWith(signal, diagnostics, report);
    } catch (error) {
      // The container vanishing mid-scan (signed out, iCloud Drive turned off) is "unavailable", never an empty snapshot.
      if (error instanceof IcloudBridgeError && error.code === "unavailable") {
        diagnostics.problems.push(error.message);
        return report({ status: "unavailable", entries: [], errorCode: ErrorCodes.unavailable });
      }
      throw error;
    }
  }

  private async scanWith(signal: AbortSignal, diagnostics: IcloudDiagnostics, report: (result: SyncScanResult) => SyncScanResult): Promise<SyncScanResult> {
    const availability = await this.bridge.availability(signal);
    if (availability.state !== "available") {
      diagnostics.problems.push(availability.message);
      return report({ status: "unavailable", entries: [], errorCode: ErrorCodes.unavailable });
    }

    const rootState = await this.prepareRoot(signal, diagnostics);
    if (rootState === "unavailable") return report({ status: "unavailable", entries: [], errorCode: ErrorCodes.unavailable });
    if (rootState === "marker-missing") return report({ status: "partial", entries: [], errorCode: ErrorCodes.markerMissing });

    let walked = await this.walk(signal);
    if (walked.placeholders.length > 0) {
      await this.resolvePlaceholders(walked.placeholders, signal);
      // Re-walk so files that just materialised are listed with real content; anything still evicted stays unresolved.
      walked = await this.walk(signal);
    }
    diagnostics.unresolvedPlaceholders = walked.placeholders;
    diagnostics.conflictCopies = walked.conflictCopies;
    diagnostics.problems.push(...walked.problems);

    const entries = walked.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (walked.problems.length > 0) {
      return report({ status: "partial", entries, errorCode: walked.problemCode ?? ErrorCodes.unreadable });
    }
    if (walked.placeholders.length > 0) return report({ status: "partial", entries, errorCode: ErrorCodes.placeholders });
    if (walked.conflictCopies.length > 0) return report({ status: "partial", entries, errorCode: ErrorCodes.conflictCopies });

    const cursor = await sha256Hex(entries.map((e) => `${e.id}\0${e.revision}`).join("\n"));
    return report({ status: "complete", mode: "snapshot", entries, cursor });
  }

  /**
   * Make sure the vault folder exists and carries our marker. An existing,
   * non-empty folder without a marker is treated as still arriving from iCloud
   * rather than as an authoritative (possibly empty) snapshot.
   */
  private async prepareRoot(signal: AbortSignal, diagnostics: IcloudDiagnostics): Promise<"ok" | "unavailable" | "marker-missing"> {
    try {
      if (!(await this.bridge.stat(this.folder, "", { maxHashBytes: 0 }, signal))) {
        await this.bridge.mkdir(this.folder, "", signal);
        await this.writeMarker(signal);
        return "ok";
      }
      const marker = await this.bridge.stat(this.folder, MARKER_FILE, { maxHashBytes: 0 }, signal);
      if (marker?.availability === "current") return "ok";
      if (marker) {
        await this.resolvePlaceholders([MARKER_FILE], signal);
        if ((await this.bridge.stat(this.folder, MARKER_FILE, { maxHashBytes: 0 }, signal))?.availability === "current") return "ok";
        diagnostics.problems.push("marker still evicted");
        return "marker-missing";
      }
      const names = ((await this.bridge.list(this.folder, "", signal)) ?? []).filter((e) => !isJunkName(e.name) && e.name !== STATE_DIR);
      if (names.length === 0) {
        await this.writeMarker(signal);
        return "ok";
      }
      diagnostics.problems.push("vault folder has content but no .geode-sync/marker.json");
      return "marker-missing";
    } catch (error) {
      if (isAbort(hostError(error))) throw error;
      diagnostics.problems.push(`prepare root: ${describe(error)}`);
      return "unavailable";
    }
  }

  private async writeMarker(signal: AbortSignal): Promise<void> {
    const marker = JSON.stringify({ schema: 1, vaultId: this.vaultId, createdAt: new Date().toISOString() });
    await this.writeBytes(MARKER_FILE, new TextEncoder().encode(marker), { any: true }, signal);
  }

  private async walk(signal: AbortSignal): Promise<WalkResult> {
    const result: WalkResult = { entries: [], placeholders: [], conflictCopies: [], problems: [] };
    const knownCreated = await this.loadCreatedPaths(signal);
    const walked = await this.bridge.walk(
      this.folder,
      "",
      { skipNames: [...WALK_SKIP.skipNames], skipPrefixes: [...WALK_SKIP.skipPrefixes], skipTopLevel: [...WALK_SKIP.skipTopLevel], maxHashBytes: this.maxFileSize },
      signal,
    );
    for (const problem of walked.problems) {
      result.problems.push(problem.message);
      if (problem.code === "symlink") result.problemCode = ErrorCodes.symlink;
    }
    const siblings = new Map<string, Set<string>>();
    for (const entry of walked.entries) {
      const slash = entry.path.lastIndexOf("/");
      const dir = slash < 0 ? "" : entry.path.slice(0, slash);
      let names = siblings.get(dir);
      if (!names) siblings.set(dir, (names = new Set()));
      names.add(entry.path.slice(slash + 1));
    }
    for (const entry of walked.entries) {
      if (entry.kind === "file" && entry.availability === "not-downloaded") {
        // An evicted file is never skipped silently and never implied deleted.
        result.placeholders.push(entry.path);
        continue;
      }
      if (entry.kind === "folder") {
        result.entries.push(entryFromStat(entry.path, entry));
        continue;
      }
      const slash = entry.path.lastIndexOf("/");
      const dir = slash < 0 ? "" : entry.path.slice(0, slash);
      const original = conflictOriginalName(entry.path.slice(slash + 1));
      if (original !== null && siblings.get(dir)?.has(original) && !knownCreated.has(entry.path)) {
        result.conflictCopies.push({ path: entry.path, original: dir ? `${dir}/${original}` : original });
        continue;
      }
      result.entries.push(entryFromStat(entry.path, entry));
    }
    return result;
  }

  /** Request downloads and wait (bounded) for the evicted items to become current. */
  private async resolvePlaceholders(paths: string[], signal: AbortSignal): Promise<void> {
    try {
      await this.bridge.startDownload(this.folder, paths, signal);
      await this.bridge.waitForDownload(this.folder, paths, { timeoutMs: this.options.placeholderWaitMs ?? 15_000, pollMs: this.options.placeholderPollMs ?? 500 }, signal);
    } catch (error) {
      // A failed request just leaves the placeholder unresolved, which reports partial.
      if (isAbort(hostError(error))) throw error;
    }
  }

  // --- reads --------------------------------------------------------------

  async read(entry: SyncRemoteEntry, signal: AbortSignal): Promise<ArrayBuffer> {
    return this.withSignal(signal, async (s) => {
      const rel = relFromId(entry.id);
      const stat = await this.requireCurrent(rel, s);
      if (!stat) throw new SyncPreconditionError(`Remote file ${rel} no longer exists`);
      if (stat.kind !== "file") throw new Error(`${rel} is not a file`);
      if (stat.size > this.maxFileSize) throw new RangeError(`${rel} exceeds the ${this.maxFileSize}-byte limit`);
      // Return what the caller asked for or fail: bytes under a different revision would poison its baseline.
      const expectedRevision = entry.revision || undefined;
      if (stat.size <= TRANSFER_CHUNK_BYTES) {
        return (await this.bridge.read(this.folder, rel, { expectedRevision, maxBytes: this.maxFileSize }, s)).bytes;
      }
      const out = new Uint8Array(stat.size);
      for (let offset = 0; offset < stat.size; offset += TRANSFER_CHUNK_BYTES) {
        // Only the first ranged read re-hashes the whole file against the listed revision; the closing stat catches a change mid-read.
        const chunk = await this.bridge.read(this.folder, rel, { offset, length: Math.min(TRANSFER_CHUNK_BYTES, stat.size - offset), expectedRevision: offset === 0 ? expectedRevision : undefined }, s);
        out.set(new Uint8Array(chunk.bytes), offset);
      }
      const after = await this.bridge.stat(this.folder, rel, { maxHashBytes: this.maxFileSize }, s);
      if (expectedRevision && after?.revision !== expectedRevision) throw new SyncPreconditionError(`Remote file ${rel} changed while it was being read`);
      return out.buffer;
    });
  }

  // --- mutations ----------------------------------------------------------

  async create(input: SyncWriteInput): Promise<SyncRemoteEntry> {
    return this.withSignal(input.signal, async (signal) => {
      const rel = normalizeRelPath(input.path);
      this.assertSize(input.data.byteLength, rel);
      // The host scans before it writes, but a first create must not depend on that: ensure the folder and marker exist.
      const availability = await this.bridge.availability(signal);
      if (availability.state !== "available") throw new Error(`iCloud is unavailable: ${availability.message}`);
      const problems: IcloudDiagnostics = { unresolvedPlaceholders: [], conflictCopies: [], problems: [] };
      if ((await this.prepareRoot(signal, problems)) !== "ok") throw new Error(`iCloud vault folder is not ready: ${problems.problems.join("; ") || "not synced yet"}`);
      const bytes = new Uint8Array(input.data);
      const sha = await sha256Hex(bytes);
      const opRel = `${OPS_DIR}/${await sha256Hex(input.operationKey)}.json`;

      const prior = await this.readOp(opRel, signal);
      if (prior) {
        if (prior.path !== rel) throw new SyncPreconditionError(`operation ${input.operationKey} was already applied to ${prior.path}`);
        const existing = await this.bridge.stat(this.folder, rel, { maxHashBytes: this.maxFileSize }, signal);
        if (existing?.availability === "not-downloaded") throw new Error(`${rel} is stored in iCloud and has not finished downloading`);
        if (existing?.kind === "file") {
          const entry = entryFromStat(rel, existing);
          // A pending record whose file holds other bytes is somebody else's file, not our interrupted write.
          if (!prior.committed && entry.hash !== prior.sha256) throw new SyncPreconditionError(`${rel} already exists`);
          return { ...entry, operationKey: input.operationKey };
        }
        if (existing) throw new SyncPreconditionError(`${rel} already exists and is not a file`);
        // Committed but gone: the create happened and the file has since moved or been deleted. Do not resurrect it.
        if (prior.committed) throw new SyncPreconditionError(`operation ${input.operationKey} was already applied; ${rel} no longer exists`);
      } else {
        await this.writeOp(opRel, { path: rel, sha256: sha, committed: false }, signal);
      }

      throwIfAborted(signal);
      const written = await this.writeBytes(rel, bytes, { absent: true }, signal);
      await this.writeOp(opRel, { path: rel, sha256: sha, committed: true }, signal);
      return { ...entryFromStat(rel, written), operationKey: input.operationKey };
    });
  }

  async update(input: SyncWriteInput & { id: string; expectedRevision: string }): Promise<SyncRemoteEntry> {
    return this.withSignal(input.signal, async (signal) => {
      const rel = relFromId(input.id);
      this.assertSize(input.data.byteLength, rel);
      await this.verifyRevision(rel, input.expectedRevision, signal);
      const written = await this.writeBytes(rel, new Uint8Array(input.data), { revision: input.expectedRevision }, signal);
      return { ...entryFromStat(rel, written), operationKey: input.operationKey };
    });
  }

  async move(input: { id: string; path: string; expectedRevision: string; signal: AbortSignal }): Promise<SyncRemoteEntry | void> {
    return this.withSignal(input.signal, async (signal) => {
      const fromRel = relFromId(input.id);
      const toRel = normalizeRelPath(input.path);
      await this.verifyRevision(fromRel, input.expectedRevision, signal);
      if (toRel === fromRel || toRel.startsWith(`${fromRel}/`)) {
        if (toRel === fromRel) return this.entryFor(toRel, signal);
        throw new Error("cannot move a folder into itself");
      }
      throwIfAborted(signal);
      const moved = await this.bridge.move(this.folder, fromRel, toRel, { expectedRevision: input.expectedRevision, maxHashBytes: this.maxFileSize }, signal);
      return entryFromStat(toRel, moved);
    });
  }

  async trash(input: { id: string; expectedRevision: string; signal: AbortSignal }): Promise<void> {
    return this.withSignal(input.signal, async (signal) => {
      const rel = relFromId(input.id);
      const stat = await this.verifyRevision(rel, input.expectedRevision, signal);
      if (stat.kind === "folder") {
        const left = ((await this.bridge.list(this.folder, rel, signal)) ?? []).filter((e) => !isJunkName(e.name));
        if (left.length > 0) throw new SyncPreconditionError(`${rel} is not empty`);
      }
      // Trash is a conditional move into .geode-trash/<bucket>/<path>; the bridge needs no trash-specific primitive.
      const bucket = `${new Date().toISOString().replace(/[:.]/g, "-")}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
      throwIfAborted(signal);
      await this.bridge.move(this.folder, rel, `${TRASH_DIR}/${bucket}/${rel}`, { expectedRevision: input.expectedRevision, maxHashBytes: this.maxFileSize }, signal);
    });
  }

  // --- helpers ------------------------------------------------------------

  private assertSize(size: number, rel: string): void {
    if (size > this.maxFileSize) throw new RangeError(`${rel} exceeds the ${this.maxFileSize}-byte limit`);
  }

  /** Stat `rel`; refuse to treat an evicted file as missing or readable: ask iCloud for it and fail closed. */
  private async requireCurrent(rel: string, signal: AbortSignal): Promise<IcloudStat | null> {
    const stat = await this.bridge.stat(this.folder, rel, { maxHashBytes: this.maxFileSize }, signal);
    if (stat?.availability === "not-downloaded") {
      await this.bridge.startDownload(this.folder, [rel], signal).catch(() => {
        /* reported below */
      });
      throw new Error(`${rel} is stored in iCloud and has not finished downloading`);
    }
    return stat;
  }

  /** Re-derive the revision from disk bytes (the bridge never caches `stat`) and compare. */
  private async verifyRevision(rel: string, expected: string, signal: AbortSignal): Promise<IcloudStat> {
    const stat = await this.requireCurrent(rel, signal);
    if (!stat) throw new SyncPreconditionError(`${rel} no longer exists`);
    if (stat.revision !== expected) throw new SyncPreconditionError(`${rel} changed (expected ${expected}, found ${stat.revision})`);
    return stat;
  }

  private async entryFor(rel: string, signal: AbortSignal): Promise<SyncRemoteEntry> {
    const stat = await this.bridge.stat(this.folder, rel, { maxHashBytes: this.maxFileSize }, signal);
    if (!stat) throw new SyncPreconditionError(`${rel} no longer exists`);
    return entryFromStat(rel, stat);
  }

  /** Stage the bytes in bounded chunks, then publish with the precondition inside one native critical section. */
  private async writeBytes(rel: string, bytes: Uint8Array, precondition: IcloudWritePrecondition, signal: AbortSignal): Promise<IcloudStat> {
    const handle = await this.bridge.beginWrite(this.folder, rel, signal);
    try {
      for (let offset = 0; offset < bytes.byteLength; offset += TRANSFER_CHUNK_BYTES) {
        throwIfAborted(signal);
        const chunk = bytes.slice(offset, offset + TRANSFER_CHUNK_BYTES);
        await this.bridge.appendChunk(handle, chunk.buffer, signal);
      }
      return await this.bridge.commitWrite(handle, precondition, { maxHashBytes: this.maxFileSize }, signal);
    } catch (error) {
      await this.bridge.discardWrite(handle).catch(() => {});
      throw error;
    }
  }

  private async readOp(opRel: string, signal: AbortSignal): Promise<OpRecord | null> {
    const stat = await this.bridge.stat(this.folder, opRel, { maxHashBytes: 0 }, signal);
    if (!stat) return null;
    if (stat.availability === "not-downloaded") {
      // An evicted record must not read as "never created": that would duplicate a create.
      await this.bridge.startDownload(this.folder, [opRel], signal).catch(() => {
        /* fail closed below */
      });
      throw new Error("create operation record is stored in iCloud and has not finished downloading");
    }
    const { bytes } = await this.bridge.read(this.folder, opRel, { maxBytes: 1024 * 1024 }, signal);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as OpRecord;
    if (typeof parsed.path !== "string" || typeof parsed.sha256 !== "string") throw new Error("malformed operation record");
    return parsed;
  }

  private async writeOp(opRel: string, record: OpRecord, signal: AbortSignal): Promise<void> {
    await this.writeBytes(opRel, new TextEncoder().encode(JSON.stringify(record)), { any: true }, signal);
  }

  /** Paths Geode itself created, exempt from conflict-copy suspicion even if they are named like one. */
  private async loadCreatedPaths(signal: AbortSignal): Promise<Set<string>> {
    const created = new Set<string>();
    const names = (await this.bridge.list(this.folder, OPS_DIR, signal)) ?? [];
    for (const entry of names) {
      throwIfAborted(signal);
      if (!entry.name.endsWith(".json") || entry.availability !== "current") continue;
      try {
        const { bytes } = await this.bridge.read(this.folder, `${OPS_DIR}/${entry.name}`, { maxBytes: 1024 * 1024 }, signal);
        const record = JSON.parse(new TextDecoder().decode(bytes)) as OpRecord;
        if (record.committed && typeof record.path === "string") created.add(record.path);
      } catch (error) {
        if (isAbort(hostError(error))) throw error;
        /* unreadable record: conservatively not exempt */
      }
    }
    return created;
  }
}

function entryFromStat(rel: string, stat: IcloudStat): SyncRemoteEntry {
  if (stat.kind === "folder") return { id: idFor(rel), path: rel, kind: "folder", revision: FOLDER_REVISION };
  const sha = stat.revision.split(":")[2];
  // Oversize files are reported with their size so the host can show them as blocked; never hashed or read.
  return { id: idFor(rel), path: rel, kind: "file", revision: stat.revision, size: stat.size, ...(sha && sha !== "-" ? { hash: sha } : {}) };
}

function idFor(rel: string): string {
  return `p:${rel}`;
}

function relFromId(id: string): string {
  if (!id.startsWith("p:")) throw new Error(`Unrecognised iCloud entry id: ${id}`);
  return normalizeRelPath(id.slice(2));
}

/** Validate and NFC-normalise a vault-relative path. Throws rather than clamping so a bad path can never reach another file. */
export function normalizeRelPath(input: string): string {
  const nfc = input.normalize("NFC");
  if (!nfc || nfc.includes("\0") || nfc.startsWith("/") || nfc.includes("\\")) throw new Error(`Invalid sync path: ${JSON.stringify(input)}`);
  const segments = nfc.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new Error(`Invalid sync path: ${JSON.stringify(input)}`);
  if (segments[0] === TRASH_DIR || segments[0] === STATE_DIR) throw new Error(`Path is reserved by the iCloud provider: ${input}`);
  if (segments.some((s) => s.startsWith(TMP_PREFIX) || realNameOfPlaceholder(s) !== null)) throw new Error(`Path is reserved by the iCloud provider: ${input}`);
  return nfc;
}

async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Translate the bridge's typed failures into what the sync engine matches on (it matches `SyncPreconditionError` by name). */
function hostError(error: unknown): unknown {
  if (!(error instanceof IcloudBridgeError)) return error;
  switch (error.code) {
    case "precondition-failed":
      return new SyncPreconditionError(error.message);
    case "aborted": {
      const aborted = new Error(error.message);
      aborted.name = "AbortError";
      return aborted;
    }
    case "too-large":
      return new RangeError(error.message);
    default:
      return new Error(error.message);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
