/**
 * Named, serialisable errors shared by the hub store, the stdio server and the
 * RPC client. `code` is the wire contract: it survives the stdio hop unchanged,
 * so the same failure has the same name whether the store is local or remote.
 */
export type StoreErrorCode =
  | "unavailable" // transport dropped / server gone: retryable
  | "lock-timeout" // could not take the single-writer lock in time: retryable
  | "aborted" // caller cancelled
  | "conflict" // differing payload under an existing immutable id
  | "hash-mismatch" // bytes do not hash to the declared sha256
  | "size-mismatch" // bytes do not match the declared size
  | "too-large" // exceeds SYNC_MAX_FILE_BYTES
  | "not-found"
  | "invalid-request" // well-framed but semantically invalid
  | "invalid-record"
  | "frame-too-large" // header line or binary frame exceeds the protocol limit
  | "bad-frame" // garbled framing; the connection cannot be resynchronised
  | "protocol" // handshake / version mismatch
  | "internal";

const RETRYABLE: ReadonlySet<StoreErrorCode> = new Set(["unavailable", "lock-timeout"]);

export class SyncStoreError extends Error {
  readonly code: StoreErrorCode;
  readonly retryable: boolean;
  constructor(code: StoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SyncStoreError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }
  toWire(): { code: StoreErrorCode; message: string; retryable: boolean } {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
  static fromWire(error: { code?: unknown; message?: unknown } | undefined): SyncStoreError {
    const code = typeof error?.code === "string" ? (error.code as StoreErrorCode) : "internal";
    return new SyncStoreError(code, typeof error?.message === "string" ? error.message : "Unknown store error");
  }
}

export const isStoreError = (error: unknown, code?: StoreErrorCode): error is SyncStoreError =>
  error instanceof SyncStoreError && (code === undefined || error.code === code);

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new SyncStoreError("aborted", "Operation aborted");
}
