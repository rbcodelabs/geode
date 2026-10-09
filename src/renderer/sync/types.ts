import type { EventRef } from "../events";
import type { SyncPreview, SyncRunResult, SyncStatus, SyncConflict } from "../../sync-core/types";
import type { SyncScope } from "../../sync-core/scope";

export * from "../../sync-core/types";

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
