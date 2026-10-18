import type { EventRef } from "../events";
import type { SyncPreview, SyncRunResult, SyncStatus, SyncConflict } from "../../sync-core/types";
import type { SyncScope } from "../../sync-core/scope";
import type { HistoryComparisonChoice, HistoryConflictComparison, HistoryResolution } from "./history-controller";

export * from "../../sync-core/types";

export interface SyncApi {
  listProviders(): Array<{ id: string; name: string }>;
  getActiveProvider(): { id: string; name: string } | null;
  getStatus(): SyncStatus;
  getScope(): Promise<SyncScope>;
  updateScope(patch: Partial<SyncScope>): Promise<void>;
  listConflicts(): Promise<SyncConflict[]>;
  resolveConflict(id: string, resolution: "keep-local" | "accept-remote"): Promise<void>;
  /**
   * Append-only (history) providers only; absent on the conditional coordinator. History conflict ids from
   * listConflicts() have an empty conflictPath. Describe returns each head's record id, device, size and deleted flag;
   * read returns the text of one side (rejects when the conflict is not comparable); resolve takes an explicit choice
   * (current local, or one displayed record id) and requires the exact displayed heads.
   */
  describeHistoryConflict?(entityId: string): Promise<HistoryConflictComparison>;
  readHistoryConflictText?(entityId: string, choice: HistoryComparisonChoice): Promise<string>;
  resolveHistoryConflict?(resolution: HistoryResolution): Promise<unknown>;
  activate(providerId: string): Promise<void>;
  disconnect(): Promise<void>;
  preview(): Promise<SyncPreview>;
  run(options?: { approvePreview?: boolean }): Promise<SyncRunResult>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  on(event: "status", callback: (status: SyncStatus) => void): EventRef;
}
