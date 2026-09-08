import type { EventRef } from "../events";
import type { SyncScope } from "./scope";

export interface SyncProviderCapabilities {
  binary: boolean;
  conditionalWrites: boolean;
  delta: boolean;
  completeSnapshots: boolean;
  atomicMoves: boolean;
  trash: boolean;
  maxFileSize?: number;
}

export interface SyncRemoteEntry {
  id: string;
  path: string;
  kind: "file" | "folder" | "tombstone";
  revision: string;
  size?: number;
  hash?: string;
  deletedPath?: string;
  /** Echoed for a create/update completed from a durable Geode journal operation. */
  operationKey?: string;
}

export interface SyncScanResult {
  status: "complete" | "partial" | "cancelled" | "unavailable";
  entries: SyncRemoteEntry[];
  cursor?: string;
  /** A delta can delete only through explicit tombstones. A complete snapshot may also prove absence. */
  mode?: "snapshot" | "delta";
  errorCode?: string;
}

export interface SyncWriteInput {
  id?: string;
  path: string;
  data: ArrayBuffer;
  expectedRevision?: string;
  signal: AbortSignal;
  /** Stable across journal replay; providers must make creates idempotent for this key. */
  operationKey: string;
}

export interface SyncSession {
  scan(cursor: string | undefined, signal: AbortSignal): Promise<SyncScanResult>;
  read(entry: SyncRemoteEntry, signal: AbortSignal): Promise<ArrayBuffer>;
  create(input: SyncWriteInput): Promise<SyncRemoteEntry>;
  update(input: SyncWriteInput & { id: string; expectedRevision: string }): Promise<SyncRemoteEntry>;
  move(input: { id: string; path: string; expectedRevision: string; signal: AbortSignal }): Promise<SyncRemoteEntry | void>;
  trash(input: { id: string; expectedRevision: string; signal: AbortSignal }): Promise<void>;
  close(): Promise<void>;
}

export interface SyncProvider {
  readonly protocol?: "conditional-mutation-v1";
  readonly id: string;
  readonly name: string;
  readonly capabilities: Readonly<SyncProviderCapabilities>;
  open(context: { vaultId: string }): Promise<SyncSession>;
}

export type SyncStatusState = "disconnected" | "idle" | "preview" | "pending" | "syncing" | "paused" | "conflict" | "error";
export interface SyncStatus { state: SyncStatusState; providerId?: string; message?: string; conflicts: number; }
export interface SyncPreview { uploads: number; downloads: number; deletes: number; conflicts: number; skipped: number; requiresApproval: boolean; }
export interface SyncRunResult extends Omit<SyncPreview, "requiresApproval"> { cursor?: string; }
export interface SyncConflict { id: string; path: string; conflictPath: string; remoteRevision: string; }

export interface SyncApi {
  listProviders(): Array<{ id: string; name: string }>;
  getActiveProvider(): { id: string; name: string } | null;
  getStatus(): SyncStatus;
  getScope(): Promise<SyncScope>;
  updateScope(patch: Partial<SyncScope>): Promise<void>;
  listConflicts(): Promise<SyncConflict[]>;
  resolveConflict(id: string, resolution: "keep-local" | "accept-remote"): Promise<void>;
  activate(providerId: string): Promise<void>;
  disconnect(): Promise<void>;
  preview(): Promise<SyncPreview>;
  run(options?: { approvePreview?: boolean }): Promise<SyncRunResult>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  on(event: "status", callback: (status: SyncStatus) => void): EventRef;
}

export class SyncPreconditionError extends Error {
  constructor(message = "Remote revision no longer matches") { super(message); this.name = "SyncPreconditionError"; }
}
