/**
 * Filesystem-backed Geode sync provider for iCloud Drive.
 *
 * The "remote" is an ordinary folder inside iCloud Drive. macOS/iCloud moves the
 * bytes between devices; this provider only exposes that folder through Geode's
 * `conditional-mutation-v1` contract. See ../README.md and ADR 0029 for the
 * design and its limits.
 *
 * Everything here is plain Node `fs`, parameterised on the remote root so tests
 * can point it at a temp dir. No renderer or Electron imports.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  SyncProvider,
  SyncProviderCapabilities,
  SyncRemoteEntry,
  SyncScanResult,
  SyncSession,
  SyncWriteInput,
} from "../../../src/renderer/sync/types";

import { ICLOUD_DRIVE_DIR, DEFAULT_APP_FOLDER, TRASH_DIR, STATE_DIR, MARKER_FILE, TMP_PREFIX, isJunkName, resolveFolderName } from "./folders";

export { ICLOUD_DRIVE_DIR, TRASH_DIR, STATE_DIR, vaultFolderName } from "./folders";
export const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;

const OPS_DIR = `${STATE_DIR}/ops`;

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
  /** Other reasons the last scan was not complete. */
  problems: string[];
}

export interface IcloudProviderOptions {
  /** iCloud Drive root. Defaults to the macOS location. Tests pass a temp dir. */
  icloudDrive?: string;
  /** Folder under the iCloud Drive root that holds per-vault folders. */
  appFolder?: string;
  maxFileSize?: number;
  /** Ask iCloud to materialise an evicted file. Defaults to `brctl download`. */
  download?: (absolutePath: string, signal: AbortSignal) => Promise<void>;
  /** How long a scan waits for requested downloads before reporting `partial`. */
  placeholderWaitMs?: number;
  placeholderPollMs?: number;
  /** Host `SyncPreconditionError`; defaults to a local class with the same `name` (the host matches by name). */
  PreconditionError?: new (message?: string) => Error;
  onDiagnostics?: (vaultId: string, diagnostics: IcloudDiagnostics) => void;
  /** The remote folder the user chose for this vault, if any. See `resolveFolderName` for the fallbacks. */
  chosenFolder?: (vaultId: string) => string | undefined | Promise<string | undefined>;
}

class LocalPreconditionError extends Error {
  constructor(message = "Remote revision no longer matches") {
    super(message);
    this.name = "SyncPreconditionError";
  }
}

export const ICLOUD_CAPABILITIES = {
  binary: true,
  conditionalWrites: true,
  delta: false,
  completeSnapshots: true,
  atomicMoves: true,
  trash: true,
} as const;

/** `brctl download` is the supported way to pull an evicted file without opening it in Finder. */
export function brctlDownload(absolutePath: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("brctl", ["download", absolutePath], { signal, timeout: 30_000 }, (error) => (error ? reject(error) : resolve()));
  });
}

export function createIcloudProvider(options: IcloudProviderOptions = {}): SyncProvider {
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const capabilities: SyncProviderCapabilities = { ...ICLOUD_CAPABILITIES, maxFileSize };
  return {
    protocol: "conditional-mutation-v1",
    id: "icloud",
    name: "iCloud Drive",
    capabilities,
    async open({ vaultId }) {
      const folder = await resolveFolderName(
        { icloudDrive: options.icloudDrive, appFolder: options.appFolder },
        vaultId,
        await options.chosenFolder?.(vaultId),
      );
      return new IcloudSession(vaultId, folder, options, maxFileSize);
    },
  };
}

/** Name of the evicted placeholder iCloud leaves for `name`. */
export function placeholderNameFor(name: string): string {
  return `.${name}.icloud`;
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

class IcloudSession implements SyncSession {
  private readonly base: string;
  private readonly root: string;
  private readonly hashCache = new Map<string, { key: string; sha: string }>();
  private closed = false;
  private readonly active = new Set<AbortController>();
  private readonly PreconditionError: new (message?: string) => Error;

  constructor(private readonly vaultId: string, folder: string, private readonly options: IcloudProviderOptions, private readonly maxFileSize: number) {
    this.base = options.icloudDrive ?? ICLOUD_DRIVE_DIR;
    this.root = path.join(this.base, options.appFolder ?? DEFAULT_APP_FOLDER, folder);
    this.PreconditionError = options.PreconditionError ?? LocalPreconditionError;
  }

  /** Test seam: the resolved remote root. */
  get remoteRoot(): string {
    return this.root;
  }

  // --- lifecycle ----------------------------------------------------------

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.hashCache.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("iCloud sync session is closed");
  }

  /** Combine the caller's signal with session close so `close()` interrupts in-flight work. */
  private async withSignal<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertOpen();
    throwIfAborted(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    this.active.add(controller);
    try {
      return await run(controller.signal);
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

    if (!(await isDirectory(this.base))) return report({ status: "unavailable", entries: [], errorCode: ErrorCodes.unavailable });

    const rootState = await this.prepareRoot(signal, diagnostics);
    if (rootState === "unavailable") return report({ status: "unavailable", entries: [], errorCode: ErrorCodes.unavailable });
    if (rootState === "marker-missing") return report({ status: "partial", entries: [], errorCode: ErrorCodes.markerMissing });

    let walked = await this.walk(signal);
    if (walked.placeholders.length > 0) {
      await this.resolvePlaceholders(walked.placeholders, signal);
      // Re-walk so files that just materialised are listed with real content; anything still evicted stays unresolved.
      walked = await this.walk(signal);
    }
    diagnostics.unresolvedPlaceholders = walked.placeholders.map((p) => p.real);
    diagnostics.conflictCopies = walked.conflictCopies;
    diagnostics.problems = walked.problems;

    const entries = walked.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (walked.problems.length > 0) {
      return report({ status: "partial", entries, errorCode: walked.problemCode ?? ErrorCodes.unreadable });
    }
    if (walked.placeholders.length > 0) return report({ status: "partial", entries, errorCode: ErrorCodes.placeholders });
    if (walked.conflictCopies.length > 0) return report({ status: "partial", entries, errorCode: ErrorCodes.conflictCopies });

    const cursor = createHash("sha256").update(entries.map((e) => `${e.id}\0${e.revision}`).join("\n")).digest("hex");
    return report({ status: "complete", mode: "snapshot", entries, cursor });
  }

  /**
   * Make sure the vault folder exists and carries our marker. An existing,
   * non-empty folder without a marker is treated as still arriving from iCloud
   * rather than as an authoritative (possibly empty) snapshot.
   */
  private async prepareRoot(signal: AbortSignal, diagnostics: IcloudDiagnostics): Promise<"ok" | "unavailable" | "marker-missing"> {
    try {
      if (!(await isDirectory(this.root))) {
        await fs.mkdir(this.root, { recursive: true });
        await this.writeMarker();
        return "ok";
      }
      if (await exists(path.join(this.root, MARKER_FILE))) return "ok";
      const stateDir = path.join(this.root, STATE_DIR);
      const markerPlaceholder = path.join(stateDir, placeholderNameFor("marker.json"));
      if (await exists(markerPlaceholder)) {
        await this.resolvePlaceholders([{ rel: `${STATE_DIR}/${placeholderNameFor("marker.json")}`, real: MARKER_FILE }], signal);
        if (await exists(path.join(this.root, MARKER_FILE))) return "ok";
        diagnostics.problems.push("marker still evicted");
        return "marker-missing";
      }
      const names = (await fs.readdir(this.root)).filter((n) => !isJunkName(n) && n !== STATE_DIR);
      if (names.length === 0) {
        await this.writeMarker();
        return "ok";
      }
      diagnostics.problems.push("vault folder has content but no .geode-sync/marker.json");
      return "marker-missing";
    } catch (error) {
      if (isAbort(error)) throw error;
      diagnostics.problems.push(`prepare root: ${describe(error)}`);
      return "unavailable";
    }
  }

  private async writeMarker(): Promise<void> {
    await fs.mkdir(path.join(this.root, STATE_DIR), { recursive: true });
    const marker = JSON.stringify({ schema: 1, vaultId: this.vaultId, createdAt: new Date().toISOString() });
    await this.writeAtomic(path.join(this.root, MARKER_FILE), new TextEncoder().encode(marker), undefined);
  }

  private async walk(signal: AbortSignal): Promise<WalkResult> {
    const result: WalkResult = { entries: [], placeholders: [], conflictCopies: [], problems: [] };
    const knownCreated = await this.loadCreatedPaths(signal);
    const visit = async (dirRel: string): Promise<void> => {
      throwIfAborted(signal);
      let dirents;
      try {
        dirents = await fs.readdir(path.join(this.root, dirRel), { withFileTypes: true });
      } catch (error) {
        result.problems.push(`readdir ${dirRel || "."}: ${describe(error)}`);
        return;
      }
      const names = new Set(dirents.map((d) => d.name.normalize("NFC")));
      for (const dirent of dirents) {
        throwIfAborted(signal);
        const name = dirent.name;
        const rel = dirRel ? `${dirRel}/${name.normalize("NFC")}` : name.normalize("NFC");
        const real = realNameOfPlaceholder(name);
        if (real !== null) {
          // A placeholder is an evicted file we cannot read yet. It is never skipped silently.
          if (!(dirRel === "" && real === TRASH_DIR)) result.placeholders.push({ rel: dirRel ? `${dirRel}/${name}` : name, real: dirRel ? `${dirRel}/${real.normalize("NFC")}` : real.normalize("NFC") });
          continue;
        }
        if (isJunkName(name)) continue;
        if (dirRel === "" && (name === TRASH_DIR || name === STATE_DIR)) continue;
        if (dirent.isSymbolicLink()) {
          result.problems.push(`symlink ${rel}`);
          result.problemCode = ErrorCodes.symlink;
          continue;
        }
        if (dirent.isDirectory()) {
          result.entries.push({ id: idFor(rel), path: rel, kind: "folder", revision: FOLDER_REVISION });
          await visit(rel);
          continue;
        }
        if (!dirent.isFile()) {
          result.problems.push(`unsupported file type ${rel}`);
          continue;
        }
        const original = conflictOriginalName(name.normalize("NFC"));
        if (original !== null && names.has(original) && !knownCreated.has(rel)) {
          result.conflictCopies.push({ path: rel, original: dirRel ? `${dirRel}/${original}` : original });
          continue;
        }
        try {
          const stat = await fs.lstat(path.join(this.root, rel));
          result.entries.push(await this.fileEntry(rel, stat, signal, true));
        } catch (error) {
          if (isAbort(error)) throw error;
          // Vanishing mid-walk is expected under iCloud; it must never read as a deletion.
          result.problems.push(`stat ${rel}: ${describe(error)}`);
        }
      }
    };
    await visit("");
    return result;
  }

  /** Request downloads and wait (bounded) for the placeholders to be replaced by real files. */
  private async resolvePlaceholders(placeholders: Array<{ rel: string; real: string }>, signal: AbortSignal): Promise<void> {
    const download = this.options.download ?? brctlDownload;
    await Promise.all(
      placeholders.map(async (p) => {
        try {
          await download(path.join(this.root, p.real), signal);
        } catch (error) {
          if (isAbort(error)) throw error;
          // A failed request just leaves the placeholder unresolved, which reports partial.
        }
      }),
    );
    const deadline = Date.now() + (this.options.placeholderWaitMs ?? 15_000);
    const poll = this.options.placeholderPollMs ?? 500;
    for (;;) {
      throwIfAborted(signal);
      const states = await Promise.all(placeholders.map(async (p) => (await exists(path.join(this.root, p.real))) && !(await exists(path.join(this.root, p.rel)))));
      if (states.every(Boolean) || Date.now() >= deadline) return;
      await sleep(poll, signal);
    }
  }

  // --- reads --------------------------------------------------------------

  async read(entry: SyncRemoteEntry, signal: AbortSignal): Promise<ArrayBuffer> {
    return this.withSignal(signal, async (s) => {
      const rel = relFromId(entry.id);
      const abs = await this.resolve(rel);
      await this.requireMaterialised(rel);
      const stat = await fs.lstat(abs);
      if (!stat.isFile()) throw new Error(`${rel} is not a file`);
      if (stat.size > this.maxFileSize) throw new RangeError(`${rel} exceeds the ${this.maxFileSize}-byte limit`);
      const bytes = await fs.readFile(abs, { signal: s });
      // Return what the caller asked for or fail: bytes under a different revision would poison its baseline.
      if (entry.revision) {
        const actual = revisionString(stat, sha256Hex(bytes));
        if (actual !== entry.revision) throw new this.PreconditionError(`Remote file ${rel} changed since it was listed`);
      }
      return toArrayBuffer(bytes);
    });
  }

  // --- mutations ----------------------------------------------------------

  async create(input: SyncWriteInput): Promise<SyncRemoteEntry> {
    return this.withSignal(input.signal, async (signal) => {
      const rel = normalizeRelPath(input.path);
      this.assertSize(input.data.byteLength, rel);
      // The host scans before it writes, but a first create must not depend on that: ensure the folder and marker exist.
      if (!(await isDirectory(this.base))) throw new Error("iCloud Drive is unavailable");
      const problems: IcloudDiagnostics = { unresolvedPlaceholders: [], conflictCopies: [], problems: [] };
      if ((await this.prepareRoot(signal, problems)) !== "ok") throw new Error(`iCloud vault folder is not ready: ${problems.problems.join("; ") || "not synced yet"}`);
      const abs = await this.resolve(rel);
      const bytes = new Uint8Array(input.data);
      const sha = sha256Hex(bytes);
      const opPath = path.join(this.root, OPS_DIR, `${sha256Hex(input.operationKey)}.json`);

      const prior = await this.readOp(opPath);
      if (prior) {
        if (prior.path !== rel) throw new this.PreconditionError(`operation ${input.operationKey} was already applied to ${prior.path}`);
        const existing = await lstatOrNull(abs);
        if (existing?.isFile()) {
          const entry = await this.fileEntry(rel, existing, signal, false);
          // A pending record whose file holds other bytes is somebody else's file, not our interrupted write.
          if (!prior.committed && entry.hash !== prior.sha256) throw new this.PreconditionError(`${rel} already exists`);
          return { ...entry, operationKey: input.operationKey };
        }
        if (existing) throw new this.PreconditionError(`${rel} already exists and is not a file`);
        // Committed but gone: the create happened and the file has since moved or been deleted. Do not resurrect it.
        if (prior.committed) throw new this.PreconditionError(`operation ${input.operationKey} was already applied; ${rel} no longer exists`);
      } else {
        await this.writeOp(opPath, { path: rel, sha256: sha, committed: false });
      }

      throwIfAborted(signal);
      await this.writeAtomic(abs, bytes, undefined, { createOnly: true }, signal);
      await this.writeOp(opPath, { path: rel, sha256: sha, committed: true });
      const stat = await fs.lstat(abs);
      return { ...(await this.fileEntry(rel, stat, signal, false)), operationKey: input.operationKey };
    });
  }

  async update(input: SyncWriteInput & { id: string; expectedRevision: string }): Promise<SyncRemoteEntry> {
    return this.withSignal(input.signal, async (signal) => {
      const rel = relFromId(input.id);
      this.assertSize(input.data.byteLength, rel);
      const abs = await this.resolve(rel);
      await this.requireMaterialised(rel);
      await this.verifyRevision(abs, rel, input.expectedRevision, signal);
      await this.writeAtomic(abs, new Uint8Array(input.data), input.expectedRevision, {}, signal);
      return { ...(await this.fileEntry(rel, await fs.lstat(abs), signal, false)), operationKey: input.operationKey };
    });
  }

  async move(input: { id: string; path: string; expectedRevision: string; signal: AbortSignal }): Promise<SyncRemoteEntry | void> {
    return this.withSignal(input.signal, async (signal) => {
      const fromRel = relFromId(input.id);
      const toRel = normalizeRelPath(input.path);
      const from = await this.resolve(fromRel);
      const to = await this.resolve(toRel);
      await this.requireMaterialised(fromRel);
      await this.verifyRevision(from, fromRel, input.expectedRevision, signal);
      if (toRel === fromRel || toRel.startsWith(`${fromRel}/`)) {
        if (toRel === fromRel) return this.entryFor(toRel, signal);
        throw new Error("cannot move a folder into itself");
      }
      const target = await lstatOrNull(to);
      if (target) {
        const source = await fs.lstat(from);
        // A case-only rename on a case-insensitive volume "exists" as the same inode; anything else is a collision.
        if (!(source.ino === target.ino && source.dev === target.dev)) throw new this.PreconditionError(`${toRel} already exists`);
      }
      await fs.mkdir(path.dirname(to), { recursive: true });
      throwIfAborted(signal);
      // Residual race: a writer could create `to` between the check above and this rename. See ADR 0029.
      await fs.rename(from, to);
      return this.entryFor(toRel, signal);
    });
  }

  async trash(input: { id: string; expectedRevision: string; signal: AbortSignal }): Promise<void> {
    return this.withSignal(input.signal, async (signal) => {
      const rel = relFromId(input.id);
      const abs = await this.resolve(rel);
      await this.requireMaterialised(rel);
      await this.verifyRevision(abs, rel, input.expectedRevision, signal);
      const stat = await fs.lstat(abs);
      if (stat.isDirectory()) {
        const left = (await fs.readdir(abs)).filter((n) => !isJunkName(n));
        if (left.length > 0) throw new this.PreconditionError(`${rel} is not empty`);
      }
      const bucket = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
      const dest = path.join(this.root, TRASH_DIR, bucket, ...rel.split("/"));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      throwIfAborted(signal);
      await fs.rename(abs, dest);
    });
  }

  // --- helpers ------------------------------------------------------------

  private assertSize(size: number, rel: string): void {
    if (size > this.maxFileSize) throw new RangeError(`${rel} exceeds the ${this.maxFileSize}-byte limit`);
  }

  /** Resolve a vault-relative path under the root, refusing symlink escapes. */
  private async resolve(rel: string): Promise<string> {
    const abs = path.join(this.root, ...rel.split("/"));
    const rootReal = await fs.realpath(this.root).catch(() => {
      throw new Error("iCloud vault folder is unavailable");
    });
    let probe = path.dirname(abs);
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error(`${rel} resolves outside the iCloud vault folder`);
        return abs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      }
    }
  }

  /** Refuse to treat an evicted file as missing or readable: ask iCloud for it and fail closed. */
  private async requireMaterialised(rel: string): Promise<void> {
    const dir = path.dirname(rel);
    const name = path.basename(rel);
    const placeholder = path.join(this.root, dir === "." ? "" : dir, placeholderNameFor(name));
    if (!(await exists(placeholder))) return;
    try {
      await (this.options.download ?? brctlDownload)(path.join(this.root, ...rel.split("/")), new AbortController().signal);
    } catch {
      /* reported below */
    }
    throw new Error(`${rel} is stored in iCloud and has not finished downloading`);
  }

  private async entryFor(rel: string, signal: AbortSignal): Promise<SyncRemoteEntry> {
    const abs = path.join(this.root, ...rel.split("/"));
    const stat = await fs.lstat(abs);
    if (stat.isDirectory()) return { id: idFor(rel), path: rel, kind: "folder", revision: FOLDER_REVISION };
    return this.fileEntry(rel, stat, signal, false);
  }

  private async fileEntry(rel: string, stat: Stats, signal: AbortSignal, useCache: boolean): Promise<SyncRemoteEntry> {
    const abs = path.join(this.root, ...rel.split("/"));
    if (stat.size > this.maxFileSize) {
      // Reported with its size so the host can show it as blocked; never hashed or read.
      return { id: idFor(rel), path: rel, kind: "file", revision: revisionString(stat, "-"), size: stat.size };
    }
    const cacheKey = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const cached = useCache ? this.hashCache.get(rel) : undefined;
    let sha = cached?.key === cacheKey ? cached.sha : undefined;
    if (!sha) {
      sha = sha256Hex(await fs.readFile(abs, { signal }));
      this.hashCache.set(rel, { key: cacheKey, sha });
    }
    return { id: idFor(rel), path: rel, kind: "file", revision: revisionString(stat, sha), size: stat.size, hash: sha };
  }

  /** Re-derive the revision from disk bytes (never from cache) and compare. */
  private async verifyRevision(abs: string, rel: string, expected: string, signal: AbortSignal): Promise<void> {
    const stat = await lstatOrNull(abs);
    if (!stat) throw new this.PreconditionError(`${rel} no longer exists`);
    let actual: string;
    if (stat.isDirectory()) actual = FOLDER_REVISION;
    else if (stat.isFile()) actual = revisionString(stat, stat.size > this.maxFileSize ? "-" : sha256Hex(await fs.readFile(abs, { signal })));
    else throw new this.PreconditionError(`${rel} is not a regular file`);
    if (actual !== expected) throw new this.PreconditionError(`${rel} changed (expected ${expected}, found ${actual})`);
  }

  /**
   * Write to a temp file beside the target, fsync, re-check the precondition,
   * then publish atomically. `createOnly` publishes with a hard link so an
   * existing target is never replaced.
   */
  private async writeAtomic(abs: string, bytes: Uint8Array, expectedRevision: string | undefined, opts: { createOnly?: boolean } = {}, signal?: AbortSignal): Promise<void> {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), `${TMP_PREFIX}${randomUUID()}`);
    const handle = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (signal) throwIfAborted(signal);
      if (opts.createOnly) {
        try {
          await fs.link(tmp, abs);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new this.PreconditionError(`${path.basename(abs)} already exists`);
          throw error;
        }
        await fs.unlink(tmp);
        return;
      }
      if (expectedRevision !== undefined) {
        // Last check before publish. A writer slipping in after this line is the accepted residual race (ADR 0029).
        await this.verifyRevision(abs, path.relative(this.root, abs), expectedRevision, signal ?? new AbortController().signal);
      }
      await fs.rename(tmp, abs);
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  private async readOp(opPath: string): Promise<OpRecord | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(opPath, "utf8")) as OpRecord;
      if (typeof parsed.path !== "string" || typeof parsed.sha256 !== "string") throw new Error("malformed operation record");
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    // An evicted record must not read as "never created": that would duplicate a create.
    const placeholder = path.join(path.dirname(opPath), placeholderNameFor(path.basename(opPath)));
    if (await exists(placeholder)) {
      try {
        await (this.options.download ?? brctlDownload)(opPath, new AbortController().signal);
      } catch {
        /* fail closed below */
      }
      throw new Error("create operation record is stored in iCloud and has not finished downloading");
    }
    return null;
  }

  private async writeOp(opPath: string, record: OpRecord): Promise<void> {
    await this.writeAtomic(opPath, new TextEncoder().encode(JSON.stringify(record)), undefined);
  }

  /** Paths Geode itself created, exempt from conflict-copy suspicion even if they are named like one. */
  private async loadCreatedPaths(signal: AbortSignal): Promise<Set<string>> {
    const created = new Set<string>();
    let names: string[];
    try {
      names = await fs.readdir(path.join(this.root, OPS_DIR));
    } catch {
      return created;
    }
    for (const name of names) {
      throwIfAborted(signal);
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await fs.readFile(path.join(this.root, OPS_DIR, name), "utf8")) as OpRecord;
        if (record.committed && typeof record.path === "string") created.add(record.path);
      } catch {
        /* unreadable record: conservatively not exempt */
      }
    }
    return created;
  }
}

interface OpRecord {
  path: string;
  sha256: string;
  committed: boolean;
}

interface WalkResult {
  entries: SyncRemoteEntry[];
  placeholders: Array<{ rel: string; real: string }>;
  conflictCopies: Array<{ path: string; original: string }>;
  problems: string[];
  problemCode?: string;
}

const FOLDER_REVISION = "folder";

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

function revisionString(stat: Pick<Stats, "mtimeMs" | "size">, sha: string): string {
  return `${Math.trunc(stat.mtimeMs)}:${stat.size}:${sha}`;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(p: string): Promise<boolean> {
  return (await lstatOrNull(p)) !== null;
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
