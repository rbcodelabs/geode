export const APPEND_ONLY_PROTOCOL = "append-only-history-v1" as const;
export const SYNC_MAX_FILE_BYTES = 100 * 1024 * 1024;
/**
 * Inline cap for read-only conflict comparison. Deliberately far stricter than
 * SYNC_MAX_FILE_BYTES: comparison text is decoded into renderer memory and
 * rendered in a dialog, so anything larger is reported as not-comparable
 * instead of being loaded.
 */
export const SYNC_CONFLICT_COMPARE_MAX_BYTES = 1024 * 1024;

export interface VaultDescriptor {
  schema: 1;
  protocol: typeof APPEND_ONLY_PROTOCOL;
  vaultId: string;
  rootId: string;
  descriptorId: string;
  name: string;
}

export interface BlobRef { id: string; sha256: string; size: number; }

export interface HistoryRecord {
  schema: 1;
  vaultId: string;
  recordId: string;
  operationId: string;
  deviceId: string;
  entityId: string;
  namespace: "content" | "portable-config";
  parents: string[];
  kind: "file" | "folder";
  deleted: boolean;
  location: { parentId: string | null; name: string };
  blob?: BlobRef;
}

export interface HistoryScan {
  blobAvailability?: Array<{ id: string; status: "available" | "pending" | "corrupt" }>;
  status: "complete" | "partial" | "cancelled" | "unavailable";
  /** Raw scoped history; validation/quarantine belongs to the core reducer. */
  records: unknown[];
  cursor?: string;
  /** Requests a full union rescan, never removal of already-known history. */
  reset?: boolean;
}

export interface AppendOnlySession {
  scan(cursor: string | undefined, signal: AbortSignal): Promise<HistoryScan>;
  putBlob(input: { operationId: string; sha256: string; size: number; data: ArrayBuffer }, signal: AbortSignal): Promise<BlobRef>;
  readBlob(ref: BlobRef, signal: AbortSignal): Promise<ArrayBuffer>;
  appendRecord(record: HistoryRecord, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface AppendOnlySyncProvider {
  readonly id: string;
  readonly name: string;
  readonly protocol: typeof APPEND_ONLY_PROTOCOL;
  readonly capabilities: { readonly binary: true; readonly conditionalWrites: false; readonly appendOnly: true; readonly delta: true; readonly maxFileSize: 104857600 };
  discover(signal: AbortSignal): Promise<VaultDescriptor[]>;
  createVault(input: { name: string; operationId: string }, signal: AbortSignal): Promise<VaultDescriptor>;
  open(context: { binding: VaultDescriptor; deviceId: string }, signal: AbortSignal): Promise<AppendOnlySession>;
  /** Device-local ownership exclusion. Never interpreted as a remote deletion. */
  excludePath?(path: string, data?: ArrayBuffer): string | null | Promise<string | null>;
}
