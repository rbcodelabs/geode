import type { BlobRef, HistoryRecord, HistoryScan, VaultDescriptor } from "../sync-core/history-types";

/**
 * IPC contract of the desktop hub sync provider (docs/design/app-hub-sync-provider.md). Types only: shared by the
 * main process (src/main/hub-sync-ipc.ts), the preload bridge and the renderer provider. No Node imports here.
 */
export type HubTarget = { kind: "fs"; path: string } | { kind: "ssh"; host: string; path: string };

/** Serialisable failure: Electron IPC drops custom fields on thrown errors, so failures travel as data. */
export interface HubErrorInfo { code: string; message: string; hint?: string }

/** What the renderer needs to drive an opened session (mirrors the optional throughput hints of AppendOnlySession). */
export interface HubOpenReply {
  sessionId: string;
  uploadConcurrency?: number;
  readConcurrency?: number;
  commitVerified?: boolean;
  appendRecords: boolean;
}

export type HubRequest =
  | { method: "discover"; target: HubTarget }
  | { method: "createVault"; target: HubTarget; input: { name: string; operationId: string } }
  | { method: "open"; target: HubTarget; binding: VaultDescriptor; deviceId: string }
  | { method: "scan"; sessionId: string; cursor: string | undefined }
  | { method: "putBlob"; sessionId: string; input: { operationId: string; sha256: string; size: number; data: ArrayBuffer } }
  | { method: "readBlob"; sessionId: string; ref: BlobRef }
  | { method: "appendRecord"; sessionId: string; record: HistoryRecord }
  | { method: "appendRecords"; sessionId: string; records: HistoryRecord[] }
  | { method: "close"; sessionId: string };

export interface HubResultMap {
  discover: VaultDescriptor[];
  createVault: VaultDescriptor;
  open: HubOpenReply;
  scan: HistoryScan;
  putBlob: BlobRef;
  readBlob: ArrayBuffer;
  appendRecord: void;
  appendRecords: { appended: number; error?: HubErrorInfo };
  close: void;
}

export type HubResponse<M extends HubRequest["method"] = HubRequest["method"]> = { ok: true; value: HubResultMap[M] } | { ok: false; error: HubErrorInfo };

/** What the preload exposes. `requestId` lets a renderer abort (`abort(requestId)`) a call that is in flight. */
export interface HubSyncBridge {
  call<R extends HubRequest>(request: R, requestId: string): Promise<HubResponse<R["method"]>>;
  abort(requestId: string): void;
}

/** Per-vault provider configuration, kept in device state (never in the vault). */
export interface HubConfig {
  schema: 1;
  target: HubTarget;
  /** Allows creating a new, empty hub vault in the store. Without it a typo cannot silently start a second history. */
  create: boolean;
}
