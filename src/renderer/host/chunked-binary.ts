import { SyncBlockedError } from "../../sync-core/ports";
import { base64ToBytes, bytesToBase64 } from "./base64";

/**
 * Files larger than one Capacitor bridge call can carry (the native plugin caps a single payload at 32 MiB),
 * moved as several ranged calls. Used by the sync host ports so every file the sync engine accepts (up to
 * SYNC_MAX_FILE_BYTES, 100 MiB) works on iOS. The single-call path is tried first and is unchanged; chunking
 * only starts once the native side has said a payload is too large.
 *
 * Reads are verified: every chunk reports the file's total size (and mtime) and a change between chunks fails the
 * read instead of returning a torn file. Writes are append-only into a temp file the native side names after the
 * operation (so a retry after a crash restarts the same file), then committed by the same atomic swap with
 * backup and rollback as a single-call write. A half-assembled write is never visible at the target.
 */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** What one bridge call carries; above this the chunked calls take over. Matches the native `binaryBridgeLimit`. */
export const SINGLE_CALL_BYTES = 32 * 1024 * 1024;
export const MAX_CHUNKED_BYTES = 100 * 1024 * 1024;

export interface ChunkTuning { chunkBytes?: number; singleCallBytes?: number; maxBytes?: number }
const tuned = (tuning: ChunkTuning = {}) => ({ chunk: tuning.chunkBytes ?? CHUNK_BYTES, single: tuning.singleCallBytes ?? SINGLE_CALL_BYTES, max: tuning.maxBytes ?? MAX_CHUNKED_BYTES });

const isTooLarge = (error: unknown) => (error as { code?: string } | null)?.code === "PAYLOAD_TOO_LARGE";
export class FileChangedDuringReadError extends SyncBlockedError {
  constructor(path: string) { super("changed-during-read", `${path} changed while it was being read in chunks`); }
}

export interface VaultBinaryNative {
  readBinary(options: { path: string }): Promise<{ base64: string }>;
  readBinaryRange?(options: { path: string; offset: number; length: number }): Promise<{ base64: string; size: number; mtime: number }>;
  writeBinary?(options: { path: string; base64: string; mutationId?: string }): Promise<unknown>;
  writeBinaryChunk?(options: { path: string; mutationId: string; offset: number; base64: string }): Promise<{ size: number }>;
  writeBinaryCommit?(options: { path: string; mutationId: string; size: number }): Promise<unknown>;
  writeBinaryAbort?(options: { path: string; mutationId: string }): Promise<unknown>;
}

export interface PrivateBinaryNative {
  syncPrivateWrite(options: { path: string; base64: string }): Promise<unknown>;
  syncPrivateRead(options: { path: string }): Promise<{ found: boolean; base64?: string }>;
  syncPrivateReadRange?(options: { path: string; offset: number; length: number }): Promise<{ found: boolean; base64?: string; size?: number }>;
  syncPrivateWriteChunk?(options: { path: string; offset: number; base64: string; final: boolean }): Promise<unknown>;
}

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer => (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;

/** The vault file's bytes: one call when it fits, ranged calls (up to `maxBytes`) when the native side says it does not. */
export async function readVaultBinary(native: VaultBinaryNative, path: string, tuning?: ChunkTuning): Promise<ArrayBuffer> {
  const { chunk, max } = tuned(tuning);
  try { return asArrayBuffer(base64ToBytes((await native.readBinary({ path })).base64)); }
  catch (error) {
    if (!isTooLarge(error) || !native.readBinaryRange) throw error;
  }
  const range = native.readBinaryRange.bind(native);
  const first = await range({ path, offset: 0, length: chunk });
  if (first.size > max) throw Object.assign(new Error(`File exceeds the ${max} byte sync limit`), { code: "PAYLOAD_TOO_LARGE" });
  const out = new Uint8Array(first.size);
  let offset = 0, part = first;
  for (;;) {
    const bytes = base64ToBytes(part.base64);
    if (part.size !== first.size || part.mtime !== first.mtime || offset + bytes.byteLength > first.size) throw new FileChangedDuringReadError(path);
    out.set(bytes, offset); offset += bytes.byteLength;
    if (offset === first.size) break;
    if (bytes.byteLength === 0) throw new FileChangedDuringReadError(path); // ended early: the file shrank
    part = await range({ path, offset, length: Math.min(chunk, first.size - offset) });
  }
  return out.buffer;
}

/**
 * Writes `data` at `path` atomically. `mutationId` must be a UUID (the sync operation id): it names the native temp file
 * and rides on the change event, exactly as for a single-call write.
 */
export async function writeVaultBinary(native: VaultBinaryNative, path: string, data: ArrayBuffer, mutationId: string, tuning?: ChunkTuning): Promise<void> {
  const { chunk, single, max } = tuned(tuning);
  if (data.byteLength > max) throw Object.assign(new Error(`File exceeds the ${max} byte sync limit`), { code: "PAYLOAD_TOO_LARGE" });
  if (data.byteLength <= single) {
    if (!native.writeBinary) throw new Error("Binary writes are unavailable in this iOS host version");
    await native.writeBinary({ path, base64: bytesToBase64(new Uint8Array(data)), mutationId });
    return;
  }
  if (!native.writeBinaryChunk || !native.writeBinaryCommit) throw Object.assign(new Error("This iOS host version cannot write files over the bridge limit"), { code: "PAYLOAD_TOO_LARGE" });
  const bytes = new Uint8Array(data);
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
      await native.writeBinaryChunk({ path, mutationId, offset, base64: bytesToBase64(bytes.subarray(offset, offset + chunk)) });
    }
    await native.writeBinaryCommit({ path, mutationId, size: bytes.byteLength });
  } catch (error) {
    await native.writeBinaryAbort?.({ path, mutationId }).catch(() => {}); // best effort: native also reclaims stale temps
    throw error;
  }
}

/** Sync-private file bytes, or null when absent. Same single-call-first rule as `readVaultBinary`. */
export async function readPrivateBinary(native: PrivateBinaryNative, path: string, tuning?: ChunkTuning): Promise<Uint8Array | null> {
  const { chunk, max } = tuned(tuning);
  try {
    const result = await native.syncPrivateRead({ path });
    return result.found && result.base64 !== undefined ? base64ToBytes(result.base64) : null;
  } catch (error) {
    if (!isTooLarge(error) || !native.syncPrivateReadRange) throw error;
  }
  const range = native.syncPrivateReadRange.bind(native);
  const first = await range({ path, offset: 0, length: chunk });
  if (!first.found || first.base64 === undefined || first.size === undefined) return null; // removed while we looked
  if (first.size > max) throw Object.assign(new Error(`File exceeds the ${max} byte sync limit`), { code: "PAYLOAD_TOO_LARGE" });
  const out = new Uint8Array(first.size);
  let offset = 0, part = first;
  for (;;) {
    const bytes = base64ToBytes(part.base64 ?? "");
    if (!part.found || part.size !== first.size || offset + bytes.byteLength > first.size) throw new Error(`${path} changed while it was being read in chunks`);
    out.set(bytes, offset); offset += bytes.byteLength;
    if (offset === first.size) return out;
    if (bytes.byteLength === 0) throw new Error(`${path} changed while it was being read in chunks`);
    part = await range({ path, offset, length: Math.min(chunk, first.size - offset) });
  }
}

/** Durable atomic write of sync-private bytes; over the bridge limit it is assembled in a `.tmp` sibling and renamed on the last chunk. */
export async function writePrivateBinary(native: PrivateBinaryNative, path: string, data: Uint8Array, tuning?: ChunkTuning): Promise<void> {
  const { chunk, single, max } = tuned(tuning);
  if (data.byteLength > max) throw Object.assign(new Error(`File exceeds the ${max} byte sync limit`), { code: "PAYLOAD_TOO_LARGE" });
  if (data.byteLength <= single) { await native.syncPrivateWrite({ path, base64: bytesToBase64(data) }); return; }
  if (!native.syncPrivateWriteChunk) throw Object.assign(new Error("This iOS host version cannot store files over the bridge limit"), { code: "PAYLOAD_TOO_LARGE" });
  for (let offset = 0; offset < data.byteLength; offset += chunk) {
    const end = Math.min(data.byteLength, offset + chunk);
    await native.syncPrivateWriteChunk({ path, offset, base64: bytesToBase64(data.subarray(offset, end)), final: end === data.byteLength });
  }
}
