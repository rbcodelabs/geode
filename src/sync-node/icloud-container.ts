import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  FOLDER_REVISION,
  ICLOUD_CONTAINER_ID,
  IcloudBridgeError,
  type IcloudAvailability,
  type IcloudContainerBridge,
  type IcloudItemAvailability,
  type IcloudListEntry,
  type IcloudReadRange,
  type IcloudStat,
  type IcloudUnavailableReason,
  type IcloudWalkEntry,
  type IcloudWalkOptions,
  type IcloudWalkProblem,
  type IcloudWalkResult,
  type IcloudWritePrecondition,
} from "../shared/icloud-container";
import { execRunner, type CommandRunner } from "./node-icloud";
import { withPathLock } from "./path-lock";

/**
 * Node `fs` implementation of the iCloud container bridge (ADR 0030, Electron side). It reads and writes the
 * container's on-disk mirror, `~/Library/Mobile Documents/iCloud~com~rbcodelabs~geode/Documents/`, with plain
 * file calls, exactly as the PR #381 community provider did for iCloud Drive. No Electron import, so it is
 * unit-tested against a temp directory.
 *
 * It NEVER creates the container or `Documents/` itself: those belong to iCloud. When they are absent the
 * bridge reports `unavailable` rather than inventing an empty remote. (`mkdir` of a *root folder inside* an
 * existing `Documents/` is the provider's call and is allowed.)
 */

export type ContainerLocation = { ok: true; documentsDir: string } | { ok: false; reason: IcloudUnavailableReason; message: string };
export type ContainerLocator = (signal?: AbortSignal) => Promise<ContainerLocation>;

/** Container directory name for an iCloud container id: dots become `~`. */
export function containerDirName(containerId: string): string {
  return containerId.replace(/\./g, "~");
}

export function realDocumentsDir(home: string = os.homedir()): string {
  return path.join(home, "Library", "Mobile Documents", containerDirName(ICLOUD_CONTAINER_ID), "Documents");
}

/**
 * Test hook: `GEODE_ICLOUD_BASE` replaces the container's `Documents/` directory (never the real one), so E2E runs
 * cannot touch a user's iCloud. Unset or blank means the real container.
 */
export function icloudDocumentsOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.GEODE_ICLOUD_BASE?.trim();
  return override ? path.resolve(override) : null;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Decide where the container is and, if it is not usable, say exactly why. Pure over its inputs so it is testable. */
export function createContainerLocator(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {}): ContainerLocator {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  return async () => {
    const override = icloudDocumentsOverride(env);
    if (override) {
      return (await isDirectory(override))
        ? { ok: true, documentsDir: override }
        : { ok: false, reason: "container-not-found", message: `The iCloud test directory ${override} does not exist.` };
    }
    if (platform !== "darwin") return { ok: false, reason: "unsupported-platform", message: "iCloud sync is only available on macOS and iOS." };
    const mobileDocuments = path.join(home, "Library", "Mobile Documents");
    if (!(await isDirectory(mobileDocuments))) {
      return { ok: false, reason: "icloud-drive-disabled", message: "iCloud Drive is not set up on this Mac. Sign in to iCloud and turn on iCloud Drive in System Settings." };
    }
    const documents = realDocumentsDir(home);
    if (!(await isDirectory(path.dirname(documents)))) {
      return {
        ok: false,
        reason: "container-not-found",
        message: `Geode's iCloud container (${ICLOUD_CONTAINER_ID}) is not on this Mac yet. It appears after Geode for iOS signed in to the same Apple ID has been opened once.`,
      };
    }
    if (!(await isDirectory(documents))) {
      return { ok: false, reason: "container-not-found", message: `Geode's iCloud container exists but has no Documents folder yet. Open Geode for iOS once so iCloud creates it.` };
    }
    return { ok: true, documentsDir: documents };
  };
}

const STUB = /^\.(.+)\.icloud$/;
const TMP_PREFIX = ".geode-tmp-";

function aborted(): IcloudBridgeError {
  return new IcloudBridgeError("aborted", "The operation was aborted");
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted();
}
function isAbort(error: unknown): boolean {
  return error instanceof IcloudBridgeError ? error.code === "aborted" : error instanceof Error && (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR");
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(aborted()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function revisionOf(stat: Pick<Stats, "mtimeMs" | "size">, sha: string): string {
  return `${Math.trunc(stat.mtimeMs)}:${stat.size}:${sha}`;
}
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const isDatalessFile = (stat: Stats, platform: NodeJS.Platform): boolean => platform === "darwin" && stat.blocks === 0 && stat.size > 0;

/** Validate a root-folder name: one plain segment directly under Documents/. */
function checkRootName(root: string): string {
  const nfc = root.normalize("NFC");
  if (!nfc || nfc.includes("\0") || nfc.includes("/") || nfc.includes("\\") || nfc === "." || nfc === ".." || nfc.startsWith(".")) {
    throw new IcloudBridgeError("invalid-path", `Invalid iCloud root folder: ${JSON.stringify(root)}`);
  }
  return nfc;
}
/** Validate and NFC-normalise a path inside a root. "" is the root itself. Throws rather than clamping. */
function checkRelPath(input: string): string[] {
  if (input === "") return [];
  const nfc = input.normalize("NFC");
  if (nfc.includes("\0") || nfc.startsWith("/") || nfc.includes("\\")) throw new IcloudBridgeError("invalid-path", `Invalid iCloud path: ${JSON.stringify(input)}`);
  const segments = nfc.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new IcloudBridgeError("invalid-path", `Invalid iCloud path: ${JSON.stringify(input)}`);
  return segments;
}

interface PendingWrite {
  handle: import("node:fs/promises").FileHandle | null;
  tmp: string;
  abs: string;
  rootReal: string;
}

export interface NodeIcloudContainerOptions {
  locate?: ContainerLocator;
  platform?: NodeJS.Platform;
  /** `brctl` runner. Defaults to a real `execFile`. */
  runner?: CommandRunner;
  downloadTimeoutMs?: number;
}

export class NodeIcloudContainer implements IcloudContainerBridge {
  private readonly locate: ContainerLocator;
  private readonly platform: NodeJS.Platform;
  private readonly runner: CommandRunner;
  private readonly downloadTimeoutMs: number;
  private readonly hashCache = new Map<string, { key: string; sha: string }>();
  private readonly pending = new Map<string, PendingWrite>();

  constructor(options: NodeIcloudContainerOptions = {}) {
    this.locate = options.locate ?? createContainerLocator();
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? execRunner;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 30_000;
  }

  /** Abort staged writes (closes handles, removes temp files). Call when the owning window goes away. */
  async close(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((handle) => this.discardWrite(handle)));
    this.hashCache.clear();
  }

  // --- location -----------------------------------------------------------

  async availability(signal?: AbortSignal): Promise<IcloudAvailability> {
    throwIfAborted(signal);
    const located = await this.locate(signal);
    return located.ok ? { state: "available", containerId: ICLOUD_CONTAINER_ID } : { state: "unavailable", reason: located.reason, message: located.message };
  }

  private async documents(signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const located = await this.locate(signal);
    if (!located.ok) throw new IcloudBridgeError("unavailable", located.message);
    return located.documentsDir;
  }

  /** Absolute path of `rel` under `root`, after proving no symlink on the way leads outside the root folder. */
  private async resolve(root: string, rel: string, signal?: AbortSignal): Promise<{ abs: string; rootAbs: string; rootReal: string }> {
    const documents = await this.documents(signal);
    const rootAbs = path.join(documents, checkRootName(root));
    const segments = checkRelPath(rel);
    let rootReal: string;
    try {
      rootReal = await fs.realpath(rootAbs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new IcloudBridgeError("not-found", `iCloud folder "${root}" does not exist`);
      throw error;
    }
    const documentsReal = await fs.realpath(documents);
    if (path.dirname(rootReal) !== documentsReal) throw new IcloudBridgeError("invalid-path", `"${root}" resolves outside the iCloud container`);
    const abs = path.join(rootAbs, ...segments);
    let probe = segments.length === 0 ? abs : path.dirname(abs);
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new IcloudBridgeError("invalid-path", `${rel || root} resolves outside the iCloud folder`);
        break;
      } catch (error) {
        if (error instanceof IcloudBridgeError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      }
    }
    return { abs, rootAbs, rootReal };
  }

  // --- reads --------------------------------------------------------------

  async listRoots(signal?: AbortSignal): Promise<string[]> {
    const documents = await this.documents(signal);
    let dirents;
    try {
      dirents = await fs.readdir(documents, { withFileTypes: true });
    } catch (error) {
      throw new IcloudBridgeError("failed", `Cannot read the iCloud container: ${describe(error)}`);
    }
    return dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name.normalize("NFC"))
      .sort((a, b) => a.localeCompare(b));
  }

  async list(root: string, rel: string, signal?: AbortSignal): Promise<IcloudListEntry[] | null> {
    let resolved;
    try {
      resolved = await this.resolve(root, rel, signal);
    } catch (error) {
      if (error instanceof IcloudBridgeError && error.code === "not-found") return null;
      throw error;
    }
    let dirents;
    try {
      dirents = await fs.readdir(resolved.abs, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const real = new Set(dirents.map((d) => d.name.normalize("NFC")));
    const out: IcloudListEntry[] = [];
    for (const dirent of dirents) {
      const name = dirent.name.normalize("NFC");
      const stub = STUB.exec(name);
      if (stub) {
        // An evicted file is reported under its real name; a real sibling of the same name wins.
        if (!real.has(stub[1])) out.push({ name: stub[1], kind: "file", availability: "not-downloaded" });
        continue;
      }
      let availability: IcloudItemAvailability = "current";
      if (dirent.isFile()) {
        const stat = await fs.lstat(path.join(resolved.abs, dirent.name)).catch(() => null);
        if (stat && isDatalessFile(stat, this.platform)) availability = "not-downloaded";
      }
      out.push({ name, kind: dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "folder" : dirent.isFile() ? "file" : "other", availability });
    }
    return out;
  }

  async stat(root: string, rel: string, options: { maxHashBytes: number }, signal?: AbortSignal): Promise<IcloudStat | null> {
    let resolved;
    try {
      resolved = await this.resolve(root, rel, signal);
    } catch (error) {
      if (error instanceof IcloudBridgeError && error.code === "not-found") return null;
      throw error;
    }
    return this.statAbs(resolved.abs, options.maxHashBytes, false, signal);
  }

  /** `null` when neither the file nor its stub exists. A symlink or special file is a precondition failure, never a stat. */
  private async statAbs(abs: string, maxHashBytes: number, useCache: boolean, signal?: AbortSignal): Promise<IcloudStat | null> {
    const stat = await fs.lstat(abs).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!stat) {
      const stub = await fs.lstat(path.join(path.dirname(abs), `.${path.basename(abs)}.icloud`)).catch(() => null);
      return stub ? { kind: "file", size: 0, mtimeMs: 0, revision: "", availability: "not-downloaded" } : null;
    }
    if (stat.isDirectory()) return { kind: "folder", size: 0, mtimeMs: stat.mtimeMs, revision: FOLDER_REVISION, availability: "current" };
    if (!stat.isFile()) throw new IcloudBridgeError("precondition-failed", `${path.basename(abs)} is not a regular file or folder`);
    if (isDatalessFile(stat, this.platform)) return { kind: "file", size: stat.size, mtimeMs: stat.mtimeMs, revision: "", availability: "not-downloaded" };
    if (stat.size > maxHashBytes) return { kind: "file", size: stat.size, mtimeMs: stat.mtimeMs, revision: revisionOf(stat, "-"), availability: "current" };
    const key = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const cached = useCache ? this.hashCache.get(abs) : undefined;
    let sha = cached?.key === key ? cached.sha : undefined;
    if (!sha) {
      sha = sha256Hex(await fs.readFile(abs, { signal }));
      this.hashCache.set(abs, { key, sha });
    }
    return { kind: "file", size: stat.size, mtimeMs: stat.mtimeMs, revision: revisionOf(stat, sha), availability: "current" };
  }

  async walk(root: string, rel: string, options: IcloudWalkOptions, signal?: AbortSignal): Promise<IcloudWalkResult> {
    const { abs: start } = await this.resolve(root, rel, signal);
    const skipNames = new Set(options.skipNames ?? []);
    const skipPrefixes = options.skipPrefixes ?? [];
    const skipTop = new Set(options.skipTopLevel ?? []);
    const entries: IcloudWalkEntry[] = [];
    const problems: IcloudWalkProblem[] = [];
    const seen = new Set<string>();
    const skipped = (name: string, top: boolean) => skipNames.has(name) || skipPrefixes.some((p) => name.startsWith(p)) || (top && skipTop.has(name));

    const visit = async (dirRel: string): Promise<void> => {
      throwIfAborted(signal);
      let dirents;
      try {
        dirents = await fs.readdir(path.join(start, dirRel), { withFileTypes: true });
      } catch (error) {
        problems.push({ code: "unreadable", message: `readdir ${dirRel || "."}: ${describe(error)}` });
        return;
      }
      const names = new Set(dirents.map((d) => d.name));
      for (const dirent of dirents) {
        throwIfAborted(signal);
        const stub = STUB.exec(dirent.name);
        const logical = (stub ? stub[1] : dirent.name).normalize("NFC");
        if (stub && names.has(stub[1])) continue; // the real file is here; the stub is stale
        if (skipped(logical, dirRel === "")) continue;
        const relPath = dirRel ? `${dirRel}/${logical}` : logical;
        if (stub) {
          entries.push({ path: relPath, kind: "file", size: 0, mtimeMs: 0, revision: "", availability: "not-downloaded" });
          continue;
        }
        if (dirent.isSymbolicLink()) {
          problems.push({ code: "symlink", message: `symlink ${relPath}` });
          continue;
        }
        if (dirent.isDirectory()) {
          entries.push({ path: relPath, kind: "folder", size: 0, mtimeMs: 0, revision: FOLDER_REVISION, availability: "current" });
          await visit(relPath);
          continue;
        }
        if (!dirent.isFile()) {
          problems.push({ code: "unsupported", message: `unsupported file type ${relPath}` });
          continue;
        }
        const fileAbs = path.join(start, ...relPath.split("/"));
        try {
          const stat = await this.statAbs(fileAbs, options.maxHashBytes, true, signal);
          // Vanishing mid-walk is expected under iCloud; it must never read as a deletion.
          if (!stat) {
            problems.push({ code: "unreadable", message: `stat ${relPath}: disappeared during the scan` });
            continue;
          }
          seen.add(fileAbs);
          entries.push({ path: relPath, ...stat });
        } catch (error) {
          if (isAbort(error)) throw error;
          problems.push({ code: "unreadable", message: `stat ${relPath}: ${describe(error)}` });
        }
      }
    };
    await visit("");
    for (const key of this.hashCache.keys()) if (key.startsWith(start + path.sep) && !seen.has(key)) this.hashCache.delete(key);
    return { entries, problems };
  }

  async read(root: string, rel: string, range: IcloudReadRange, signal?: AbortSignal): Promise<{ bytes: ArrayBuffer; revision: string }> {
    const { abs } = await this.resolve(root, rel, signal);
    const stat = await fs.lstat(abs).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new IcloudBridgeError("not-found", `${rel} does not exist`);
      throw error;
    });
    if (!stat.isFile()) throw new IcloudBridgeError("failed", `${rel} is not a file`);
    if (isDatalessFile(stat, this.platform)) throw new IcloudBridgeError("unavailable", `${rel} is stored in iCloud and has not finished downloading`);
    if (range.maxBytes !== undefined && stat.size > range.maxBytes) throw new IcloudBridgeError("too-large", `${rel} exceeds the ${range.maxBytes}-byte limit`);
    const whole = (range.offset ?? 0) === 0 && range.length === undefined;
    let bytes: Uint8Array;
    let revision = "";
    if (whole) {
      bytes = await fs.readFile(abs, { signal });
      revision = revisionOf(stat, sha256Hex(bytes));
    } else {
      if (range.expectedRevision) {
        // A ranged read can only vouch for the file if the whole file still hashes to what the caller listed.
        revision = revisionOf(stat, sha256Hex(await fs.readFile(abs, { signal })));
      }
      const handle = await fs.open(abs, "r");
      try {
        const length = Math.min(range.length ?? stat.size, Math.max(0, stat.size - (range.offset ?? 0)));
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, range.offset ?? 0);
        bytes = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    }
    // Return what the caller asked for or fail: bytes under a different revision would poison its baseline.
    if (range.expectedRevision && revision !== range.expectedRevision) throw new IcloudBridgeError("precondition-failed", `Remote file ${rel} changed since it was listed`);
    return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, revision };
  }

  // --- staged conditional writes ------------------------------------------

  async beginWrite(root: string, rel: string, signal?: AbortSignal): Promise<string> {
    const { abs, rootReal } = await this.resolve(root, rel, signal);
    if (checkRelPath(rel).length === 0) throw new IcloudBridgeError("invalid-path", "Cannot write the root folder");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // Re-check after creating parents: nothing we just made may lead outside the root.
    const parentReal = await fs.realpath(path.dirname(abs));
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) throw new IcloudBridgeError("invalid-path", `${rel} resolves outside the iCloud folder`);
    const tmp = path.join(path.dirname(abs), `${TMP_PREFIX}${randomUUID()}`);
    const handle = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
    const id = randomUUID();
    this.pending.set(id, { handle, tmp, abs, rootReal });
    return id;
  }

  private pendingWrite(handle: string): PendingWrite {
    const write = this.pending.get(handle);
    if (!write) throw new IcloudBridgeError("failed", "Unknown or finished write handle");
    return write;
  }

  async appendChunk(handle: string, bytes: ArrayBuffer, signal?: AbortSignal): Promise<void> {
    try {
      throwIfAborted(signal);
      const write = this.pendingWrite(handle);
      if (!write.handle) throw new IcloudBridgeError("failed", "Write already committed");
      await write.handle.write(new Uint8Array(bytes));
    } catch (error) {
      await this.discardWrite(handle);
      throw error;
    }
  }

  async commitWrite(handle: string, precondition: IcloudWritePrecondition, options: { maxHashBytes: number }, signal?: AbortSignal): Promise<IcloudStat> {
    const write = this.pendingWrite(handle);
    try {
      throwIfAborted(signal);
      if (write.handle) {
        await write.handle.sync();
        await write.handle.close();
        write.handle = null;
      }
      await withPathLock([write.abs], async () => {
        throwIfAborted(signal);
        if ("absent" in precondition) {
          // A hard link publishes the bytes only if the name is free, so an existing target is never replaced.
          try {
            await fs.link(write.tmp, write.abs);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new IcloudBridgeError("precondition-failed", `${path.basename(write.abs)} already exists`);
            throw error;
          }
          await fs.unlink(write.tmp);
          return;
        }
        if ("revision" in precondition) {
          // Last check before publish. A writer slipping in after this line is the accepted residual race (ADR 0029/0030).
          await this.verifyRevision(write.abs, precondition.revision, options.maxHashBytes);
        }
        await fs.rename(write.tmp, write.abs);
      });
      this.pending.delete(handle);
      const stat = await this.statAbs(write.abs, options.maxHashBytes, false, signal);
      if (!stat) throw new IcloudBridgeError("failed", "The file disappeared right after it was written");
      return stat;
    } catch (error) {
      await this.discardWrite(handle);
      throw error;
    }
  }

  async discardWrite(handle: string): Promise<void> {
    const write = this.pending.get(handle);
    if (!write) return;
    this.pending.delete(handle);
    await write.handle?.close().catch(() => {});
    await fs.unlink(write.tmp).catch(() => {});
  }

  /** Re-derive the revision from disk bytes (never from cache) and compare. */
  private async verifyRevision(abs: string, expected: string, maxHashBytes: number): Promise<void> {
    const name = path.basename(abs);
    const stat = await fs.lstat(abs).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!stat) throw new IcloudBridgeError("precondition-failed", `${name} no longer exists`);
    let actual: string;
    if (stat.isDirectory()) actual = FOLDER_REVISION;
    else if (stat.isFile()) actual = revisionOf(stat, stat.size > maxHashBytes ? "-" : sha256Hex(await fs.readFile(abs)));
    else throw new IcloudBridgeError("precondition-failed", `${name} is not a regular file`);
    if (actual !== expected) throw new IcloudBridgeError("precondition-failed", `${name} changed (expected ${expected}, found ${actual})`);
  }

  async move(root: string, from: string, to: string, options: { expectedRevision: string; maxHashBytes: number }, signal?: AbortSignal): Promise<IcloudStat> {
    const source = await this.resolve(root, from, signal);
    const target = await this.resolve(root, to, signal);
    if (checkRelPath(from).length === 0 || checkRelPath(to).length === 0) throw new IcloudBridgeError("invalid-path", "Cannot move the root folder");
    return withPathLock([source.abs, target.abs], async () => {
      await this.verifyRevision(source.abs, options.expectedRevision, options.maxHashBytes);
      const existing = await fs.lstat(target.abs).catch(() => null);
      if (existing) {
        const sourceStat = await fs.lstat(source.abs);
        // A case-only rename on a case-insensitive volume "exists" as the same inode; anything else is a collision.
        if (!(sourceStat.ino === existing.ino && sourceStat.dev === existing.dev)) throw new IcloudBridgeError("precondition-failed", `${to} already exists`);
      }
      await fs.mkdir(path.dirname(target.abs), { recursive: true });
      const parentReal = await fs.realpath(path.dirname(target.abs));
      if (parentReal !== target.rootReal && !parentReal.startsWith(target.rootReal + path.sep)) throw new IcloudBridgeError("invalid-path", `${to} resolves outside the iCloud folder`);
      throwIfAborted(signal);
      // Residual race: a writer could create the target between the check above and this rename (ADR 0029/0030).
      await fs.rename(source.abs, target.abs);
      const stat = await this.statAbs(target.abs, options.maxHashBytes, false, signal);
      if (!stat) throw new IcloudBridgeError("failed", "The item disappeared right after it was moved");
      return stat;
    });
  }

  async mkdir(root: string, rel: string, signal?: AbortSignal): Promise<void> {
    const documents = await this.documents(signal);
    const rootAbs = path.join(documents, checkRootName(root));
    const segments = checkRelPath(rel);
    if (segments.length === 0) {
      await fs.mkdir(rootAbs, { recursive: false }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      return;
    }
    const { abs, rootReal } = await this.resolve(root, rel, signal);
    await fs.mkdir(abs, { recursive: true });
    const real = await fs.realpath(abs);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new IcloudBridgeError("invalid-path", `${rel} resolves outside the iCloud folder`);
  }

  // --- downloads ----------------------------------------------------------

  async startDownload(root: string, paths: string[], signal?: AbortSignal): Promise<void> {
    await Promise.all(
      paths.map(async (rel) => {
        throwIfAborted(signal);
        const { abs } = await this.resolve(root, rel, signal);
        // A failed request just leaves the item not-downloaded, which callers report as an incomplete scan.
        await this.runner("brctl", ["download", abs], { timeoutMs: this.downloadTimeoutMs }).catch(() => ({ code: null, stderr: "" }));
      }),
    );
  }

  async waitForDownload(root: string, paths: string[], options: { timeoutMs: number; pollMs: number }, signal?: AbortSignal): Promise<{ ready: string[]; pending: string[] }> {
    const targets = await Promise.all(paths.map(async (rel) => ({ rel, abs: (await this.resolve(root, rel, signal)).abs })));
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      throwIfAborted(signal);
      const states = await Promise.all(targets.map(async (t) => ({ rel: t.rel, ready: await this.isCurrent(t.abs) })));
      const pending = states.filter((s) => !s.ready).map((s) => s.rel);
      if (pending.length === 0 || Date.now() >= deadline) return { ready: states.filter((s) => s.ready).map((s) => s.rel), pending };
      await sleep(options.pollMs, signal);
    }
  }

  private async isCurrent(abs: string): Promise<boolean> {
    if (await fs.lstat(path.join(path.dirname(abs), `.${path.basename(abs)}.icloud`)).then(() => true, () => false)) return false;
    const stat = await fs.lstat(abs).catch(() => null);
    return !!stat && !isDatalessFile(stat, this.platform);
  }
}
