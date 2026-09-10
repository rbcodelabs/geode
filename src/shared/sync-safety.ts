export interface GuardedMutation {
  namespace?: "content" | "portable-config";
  operationId: string;
  path: string;
  expectedHash: string | null;
  kind: "write" | "trash" | "mkdir";
  data?: ArrayBuffer;
}
export interface GuardedMutationResult { status: "applied" | "already-applied"; hash: string | null; recoveryPath: string; }
export type SyncStorageRequest = { action: "stage"; key: string; data: ArrayBuffer } | { action: "read-stage"; key: string } | { action: "save-operation"; key: string; value: unknown } | { action: "load-operations" };
export interface SyncSafetyService {
  storage(token: string, binding: string, request: SyncStorageRequest): Promise<unknown>;
  claimOwner(): Promise<string | null>;
  releaseOwner(token: string): Promise<void>;
  apply(token: string, input: GuardedMutation): Promise<GuardedMutationResult>;
  onPrepare(handler: (token: string, path: string) => Promise<string | null>): () => void;
  onRelease(handler: (token: string) => Promise<void>): () => void;
}
