import { registerPlugin, type Plugin } from "@capacitor/core";
import {
  IcloudBridgeError,
  type IcloudAvailability,
  type IcloudBridgeErrorCode,
  type IcloudContainerBridge,
  type IcloudListEntry,
  type IcloudReadRange,
  type IcloudStat,
  type IcloudWalkOptions,
  type IcloudWalkResult,
  type IcloudWritePrecondition,
} from "../../shared/icloud-container";

/**
 * JS side of the Swift `GeodeIcloudContainer` plugin (ADR 0030). The native plugin is a thin Capacitor wrapper over
 * `IcloudContainerEngine`; this adapter turns its wire format (base64 bytes, `found` flags, rejection codes) back into
 * the platform-neutral `IcloudContainerBridge` the single TypeScript provider consumes. Every call carries a
 * `requestId` so an `AbortSignal` can cancel long native work (`walk`, `waitForDownload`, hashing).
 */
export interface IcloudContainerPlugin extends Plugin {
  availability(): Promise<IcloudAvailability>;
  listRoots(options: { requestId?: string }): Promise<{ roots: string[] }>;
  list(options: { root: string; path: string; requestId?: string }): Promise<{ found: false } | { found: true; entries: IcloudListEntry[] }>;
  walk(options: { root: string; path: string; skipNames: string[]; skipPrefixes: string[]; skipTopLevel: string[]; maxHashBytes: number; requestId?: string }): Promise<IcloudWalkResult>;
  stat(options: { root: string; path: string; maxHashBytes: number; requestId?: string }): Promise<{ found: false } | { found: true; stat: IcloudStat }>;
  read(options: { root: string; path: string; offset?: number; length?: number; expectedRevision?: string; maxBytes?: number; requestId?: string }): Promise<{ base64: string; revision: string }>;
  beginWrite(options: { root: string; path: string; requestId?: string }): Promise<{ handle: string }>;
  appendChunk(options: { handle: string; base64: string; requestId?: string }): Promise<Record<string, never>>;
  commitWrite(options: { handle: string; precondition: "absent" | "revision" | "any"; revision?: string; maxHashBytes: number; requestId?: string }): Promise<{ stat: IcloudStat }>;
  discardWrite(options: { handle: string }): Promise<Record<string, never>>;
  move(options: { root: string; from: string; to: string; expectedRevision: string; maxHashBytes: number; requestId?: string }): Promise<{ stat: IcloudStat }>;
  mkdir(options: { root: string; path: string; requestId?: string }): Promise<Record<string, never>>;
  startDownload(options: { root: string; paths: string[]; requestId?: string }): Promise<Record<string, never>>;
  waitForDownload(options: { root: string; paths: string[]; timeoutMs: number; pollMs: number; requestId?: string }): Promise<{ ready: string[]; pending: string[] }>;
  abort(options: { requestId: string }): Promise<Record<string, never>>;
}

export const GeodeIcloudContainer = registerPlugin<IcloudContainerPlugin>("GeodeIcloudContainer");

const BRIDGE_CODES: ReadonlySet<string> = new Set<IcloudBridgeErrorCode>([
  "precondition-failed", "not-found", "unavailable", "aborted", "too-large", "invalid-path", "failed",
]);

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  // Sliced so a multi-megabyte chunk never exceeds the argument limit of fromCharCode.
  for (let offset = 0; offset < view.length; offset += 0x8000) binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function fromBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Capacitor rejections carry `{ message, code }`. Unknown codes and a missing native plugin never masquerade as success. */
function toBridgeError(error: unknown): IcloudBridgeError {
  if (error instanceof IcloudBridgeError) return error;
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  if (code && BRIDGE_CODES.has(code)) return new IcloudBridgeError(code as IcloudBridgeErrorCode, message ?? code);
  if (code === "UNIMPLEMENTED") return new IcloudBridgeError("unavailable", "This build of Geode does not include the iCloud container plugin.");
  return new IcloudBridgeError("failed", message ?? String(error));
}

export function createCapacitorIcloudBridge(plugin: IcloudContainerPlugin, newRequestId: () => string = () => globalThis.crypto.randomUUID()): IcloudContainerBridge {
  const call = async <T>(signal: AbortSignal | undefined, invoke: (requestId: string) => Promise<T>): Promise<T> => {
    if (signal?.aborted) throw new IcloudBridgeError("aborted", "The operation was aborted");
    const requestId = newRequestId();
    const onAbort = () => { void plugin.abort({ requestId }).catch(() => {}); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await invoke(requestId);
    } catch (error) {
      throw toBridgeError(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };

  return {
    availability: async (signal) => {
      if (signal?.aborted) throw new IcloudBridgeError("aborted", "The operation was aborted");
      try {
        return await plugin.availability();
      } catch (error) {
        // A build without the native plugin must read as "unavailable", never as an empty remote.
        return { state: "unavailable", reason: "unsupported-platform", message: toBridgeError(error).message };
      }
    },
    listRoots: (signal) => call(signal, async (requestId) => (await plugin.listRoots({ requestId })).roots),
    list: (root, path, signal) => call(signal, async (requestId) => {
      const result = await plugin.list({ root, path, requestId });
      return result.found ? result.entries : null;
    }),
    walk: (root, path, options: IcloudWalkOptions, signal) => call(signal, (requestId) => plugin.walk({
      root, path, requestId, maxHashBytes: options.maxHashBytes,
      skipNames: options.skipNames ?? [], skipPrefixes: options.skipPrefixes ?? [], skipTopLevel: options.skipTopLevel ?? [],
    })),
    stat: (root, path, options, signal) => call(signal, async (requestId) => {
      const result = await plugin.stat({ root, path, maxHashBytes: options.maxHashBytes, requestId });
      return result.found ? result.stat : null;
    }),
    read: (root, path, range: IcloudReadRange, signal) => call(signal, async (requestId) => {
      const result = await plugin.read({ root, path, requestId, offset: range.offset, length: range.length, expectedRevision: range.expectedRevision, maxBytes: range.maxBytes });
      return { bytes: fromBase64(result.base64), revision: result.revision };
    }),
    beginWrite: (root, path, signal) => call(signal, async (requestId) => (await plugin.beginWrite({ root, path, requestId })).handle),
    appendChunk: (handle, bytes, signal) => call(signal, async (requestId) => { await plugin.appendChunk({ handle, base64: toBase64(bytes), requestId }); }),
    commitWrite: (handle, precondition: IcloudWritePrecondition, options, signal) => call(signal, async (requestId) => {
      const wire = "absent" in precondition ? { precondition: "absent" as const }
        : "revision" in precondition ? { precondition: "revision" as const, revision: precondition.revision }
          : { precondition: "any" as const };
      return (await plugin.commitWrite({ handle, ...wire, maxHashBytes: options.maxHashBytes, requestId })).stat;
    }),
    discardWrite: (handle) => call(undefined, async () => { await plugin.discardWrite({ handle }); }),
    move: (root, from, to, options, signal) => call(signal, async (requestId) => (await plugin.move({ root, from, to, expectedRevision: options.expectedRevision, maxHashBytes: options.maxHashBytes, requestId })).stat),
    mkdir: (root, path, signal) => call(signal, async (requestId) => { await plugin.mkdir({ root, path, requestId }); }),
    startDownload: (root, paths, signal) => call(signal, async (requestId) => { await plugin.startDownload({ root, paths, requestId }); }),
    waitForDownload: (root, paths, options, signal) => call(signal, (requestId) => plugin.waitForDownload({ root, paths, timeoutMs: options.timeoutMs, pollMs: options.pollMs, requestId })),
  };
}
