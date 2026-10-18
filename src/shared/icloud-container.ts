/**
 * Platform-neutral bridge to Geode's iCloud container (ADR 0030).
 *
 * The bridge is deliberately policy-free: it exposes small, natively atomic primitives (list, walk, stat,
 * read, staged conditional write, move, mkdir, download, availability). Everything that decides what a
 * sync *means* (folder naming, marker, op index, trash layout, conflict-copy heuristic, scan assembly,
 * capabilities) lives in ONE TypeScript provider (`renderer/internal-plugins/icloud-sync`). Electron
 * implements this over Node `fs` behind IPC; iOS will implement it over `NSFileCoordinator`.
 *
 * Types only, no Node or DOM imports: shared by main, preload and renderer.
 *
 * Addressing: every call names a `root` (one folder directly under the container's `Documents/`, e.g.
 * "My Vault") and a `path` relative to that root ("" is the root itself). Paths are NFC, "/"-separated and
 * may never contain "..", "." or empty segments. An implementation must refuse anything that resolves
 * outside the root, including through symlinks.
 *
 * Revisions are `mtimeMs:size:sha256hex` (the third segment is "-" for files over `maxHashBytes`, which are
 * never read) and `"folder"` for directories. They are computed natively from disk and are the sole
 * compare-and-swap token.
 */

export const ICLOUD_CONTAINER_ID = "iCloud.com.rbcodelabs.geode";
export const FOLDER_REVISION = "folder";

export type IcloudUnavailableReason =
  | "not-signed-in"
  | "icloud-drive-disabled"
  | "container-not-found"
  | "unsupported-platform"
  | "permission-denied";

export type IcloudAvailability =
  | { state: "available"; containerId: string }
  | { state: "unavailable"; reason: IcloudUnavailableReason; message: string };

/**
 * `current`: bytes are on this device. `not-downloaded`: iCloud knows the file but its bytes are evicted
 * (a `.name.icloud` stub or a dataless file); platform differences are normalised here, so callers only
 * ever see the real name. A not-downloaded entry has an empty `revision`.
 */
export type IcloudItemAvailability = "current" | "not-downloaded";

export interface IcloudStat {
  kind: "file" | "folder";
  size: number;
  mtimeMs: number;
  revision: string;
  availability: IcloudItemAvailability;
}

export interface IcloudWalkEntry extends IcloudStat {
  /** Relative to the walked directory. */
  path: string;
}

export interface IcloudWalkProblem {
  code: "symlink" | "unreadable" | "unsupported";
  message: string;
}

export interface IcloudWalkResult {
  entries: IcloudWalkEntry[];
  /** Anything that makes this listing not a complete snapshot (a symlink, an unreadable folder). Never silently dropped. */
  problems: IcloudWalkProblem[];
}

export interface IcloudWalkOptions {
  /** Names skipped at any depth (exact match). */
  skipNames?: string[];
  /** Names skipped at any depth when they start with one of these. */
  skipPrefixes?: string[];
  /** Names skipped only directly under the walked directory. */
  skipTopLevel?: string[];
  /** Files larger than this are listed with their size but never read or hashed. */
  maxHashBytes: number;
}

export interface IcloudListEntry {
  name: string;
  kind: "file" | "folder" | "symlink" | "other";
  availability: IcloudItemAvailability;
}

export type IcloudWritePrecondition =
  /** Create only: never replaces an existing path. */
  | { absent: true }
  /** Replace only if the bytes on disk still hash to this revision. */
  | { revision: string }
  /** Replace unconditionally (marker and op records, which are ours alone). */
  | { any: true };

export interface IcloudReadRange {
  offset?: number;
  length?: number;
  /** If set, the file's current full revision must equal this or the read fails with `precondition-failed`. */
  expectedRevision?: string;
  maxBytes?: number;
}

export type IcloudBridgeErrorCode =
  | "precondition-failed"
  | "not-found"
  | "unavailable"
  | "aborted"
  | "too-large"
  | "invalid-path"
  | "failed";

export class IcloudBridgeError extends Error {
  constructor(readonly code: IcloudBridgeErrorCode, message: string) {
    super(message);
    this.name = "IcloudBridgeError";
  }
}

export interface IcloudContainerBridge {
  availability(signal?: AbortSignal): Promise<IcloudAvailability>;
  /** Folders directly under `Documents/` that could be remote roots (non-hidden directories, NFC, sorted). */
  listRoots(signal?: AbortSignal): Promise<string[]>;
  /** Shallow listing including dot-files; null when the directory does not exist. Stubs are reported under their real name. */
  list(root: string, path: string, signal?: AbortSignal): Promise<IcloudListEntry[] | null>;
  /** Complete recursive snapshot below `path`. Hashes are cached natively by dev/inode/mtime/ctime/size. */
  walk(root: string, path: string, options: IcloudWalkOptions, signal?: AbortSignal): Promise<IcloudWalkResult>;
  /** Fresh (never cached) stat with revision; null when nothing exists at `path` (neither the file nor its stub). */
  stat(root: string, path: string, options: { maxHashBytes: number }, signal?: AbortSignal): Promise<IcloudStat | null>;
  read(root: string, path: string, range: IcloudReadRange, signal?: AbortSignal): Promise<{ bytes: ArrayBuffer; revision: string }>;
  /** Stage a write for `path` (the temp file lives beside it so the final publish is one atomic rename). Returns a handle. */
  beginWrite(root: string, path: string, signal?: AbortSignal): Promise<string>;
  appendChunk(handle: string, bytes: ArrayBuffer, signal?: AbortSignal): Promise<void>;
  /** Verify the precondition and publish inside one native critical section. */
  commitWrite(handle: string, precondition: IcloudWritePrecondition, options: { maxHashBytes: number }, signal?: AbortSignal): Promise<IcloudStat>;
  discardWrite(handle: string): Promise<void>;
  /** Conditional, non-overwriting rename. `expectedRevision` is checked against disk bytes first. */
  move(root: string, from: string, to: string, options: { expectedRevision: string; maxHashBytes: number }, signal?: AbortSignal): Promise<IcloudStat>;
  mkdir(root: string, path: string, signal?: AbortSignal): Promise<void>;
  /** Ask iCloud to materialise evicted items. Failures are not fatal: the next wait simply reports them pending. */
  startDownload(root: string, paths: string[], signal?: AbortSignal): Promise<void>;
  waitForDownload(root: string, paths: string[], options: { timeoutMs: number; pollMs: number }, signal?: AbortSignal): Promise<{ ready: string[]; pending: string[] }>;
}

/** Method names that cross the process boundary, in the order of the interface. `discardWrite` carries no signal. */
export const ICLOUD_BRIDGE_METHODS = [
  "availability", "listRoots", "list", "walk", "stat", "read", "beginWrite", "appendChunk", "commitWrite",
  "discardWrite", "move", "mkdir", "startDownload", "waitForDownload",
] as const satisfies ReadonlyArray<keyof IcloudContainerBridge>;
export type IcloudBridgeMethod = (typeof ICLOUD_BRIDGE_METHODS)[number];

export interface IcloudBridgeFailure {
  code: IcloudBridgeErrorCode;
  message: string;
}
export type IcloudBridgeResponse = { ok: true; value: unknown } | { ok: false; error: IcloudBridgeFailure };

/** What the preload exposes. `requestId` lets the renderer abort a call that is in flight. */
export interface IcloudContainerIpc {
  call(method: IcloudBridgeMethod, args: unknown[], requestId: string): Promise<IcloudBridgeResponse>;
  abort(requestId: string): void;
}

/**
 * Wrap the preload IPC in the typed bridge. Errors come back as plain `{code,message}` (IPC flattens Error
 * subclasses), and are rebuilt as `IcloudBridgeError` so the provider can branch on `code`.
 */
export function createIpcIcloudBridge(ipc: IcloudContainerIpc, newRequestId: () => string = () => globalThis.crypto.randomUUID()): IcloudContainerBridge {
  const invoke = async (method: IcloudBridgeMethod, args: unknown[], signal?: AbortSignal): Promise<unknown> => {
    if (signal?.aborted) throw new IcloudBridgeError("aborted", "The operation was aborted");
    const requestId = newRequestId();
    const onAbort = () => ipc.abort(requestId);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await ipc.call(method, args, requestId);
      if (!response.ok) throw new IcloudBridgeError(response.error.code, response.error.message);
      return response.value;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
  return {
    availability: (signal) => invoke("availability", [], signal) as Promise<IcloudAvailability>,
    listRoots: (signal) => invoke("listRoots", [], signal) as Promise<string[]>,
    list: (root, path, signal) => invoke("list", [root, path], signal) as Promise<IcloudListEntry[] | null>,
    walk: (root, path, options, signal) => invoke("walk", [root, path, options], signal) as Promise<IcloudWalkResult>,
    stat: (root, path, options, signal) => invoke("stat", [root, path, options], signal) as Promise<IcloudStat | null>,
    read: (root, path, range, signal) => invoke("read", [root, path, range], signal) as Promise<{ bytes: ArrayBuffer; revision: string }>,
    beginWrite: (root, path, signal) => invoke("beginWrite", [root, path], signal) as Promise<string>,
    appendChunk: (handle, bytes, signal) => invoke("appendChunk", [handle, bytes], signal) as Promise<void>,
    commitWrite: (handle, precondition, options, signal) => invoke("commitWrite", [handle, precondition, options], signal) as Promise<IcloudStat>,
    discardWrite: (handle) => invoke("discardWrite", [handle]) as Promise<void>,
    move: (root, from, to, options, signal) => invoke("move", [root, from, to, options], signal) as Promise<IcloudStat>,
    mkdir: (root, path, signal) => invoke("mkdir", [root, path], signal) as Promise<void>,
    startDownload: (root, paths, signal) => invoke("startDownload", [root, paths], signal) as Promise<void>,
    waitForDownload: (root, paths, options, signal) => invoke("waitForDownload", [root, paths, options], signal) as Promise<{ ready: string[]; pending: string[] }>,
  };
}
