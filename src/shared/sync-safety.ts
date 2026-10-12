export interface GuardedMutation {
  namespace?: "content" | "portable-config";
  operationId: string;
  path: string;
  expectedHash: string | null;
  kind: "write" | "trash" | "mkdir";
  data?: ArrayBuffer;
}
export interface GuardedMutationResult { status: "applied" | "already-applied"; hash: string | null; recoveryPath: string; /** Present only when a stagingDir was configured: where the temp file actually went. */ stagingUsed?: "stagingDir" | "beside-target"; }
export type SyncStorageRequest = { action: "stage"; key: string; data: ArrayBuffer } | { action: "read-stage"; key: string } | { action: "save-operation"; key: string; value: unknown } | { action: "load-operations"; /** Only these journals (a host may ignore this and return all). */ ids?: string[] } | { action: "release"; key: string } | { action: "release-bytes"; key: string } | { action: "gc"; retain: string[] } | { action: "sweep"; keep: string[]; force: boolean };
/**
 * What one guarded apply did, handed to release handlers by hosts that can say (the mobile host). A handler that gets it can
 * refresh just that path instead of rescanning the vault; one that does not (the desktop) falls back to a full refresh.
 * `changed` is false when the apply failed and left the path alone.
 */
export interface SyncApplyOutcome { namespace: "content" | "portable-config"; path: string; kind: GuardedMutation["kind"]; size?: number; changed: boolean }
export interface SyncSafetyService {
  storage(token: string, binding: string, request: SyncStorageRequest): Promise<unknown>;
  claimOwner(): Promise<string | null>;
  releaseOwner(token: string): Promise<void>;
  apply(token: string, input: GuardedMutation): Promise<GuardedMutationResult>;
  onPrepare(handler: (token: string, path: string) => Promise<string | null>): () => void;
  onRelease(handler: (token: string, outcome?: SyncApplyOutcome) => Promise<void>): () => void;
}
