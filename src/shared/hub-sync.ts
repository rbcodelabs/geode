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
  | { method: "probe"; target: HubTarget; create: boolean }
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
  probe: HubProbeResult;
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

/**
 * Strict ssh host grammar: a hostname, IPv4 address or ~/.ssh/config alias, optionally `user@`. It must start with an
 * alphanumeric (never `-`, so ssh can never read it as an option), and contains no whitespace, control characters,
 * quotes, `;`, `$`, backticks or any other shell/ssh metacharacter. IPv6 literals are not accepted; use an alias.
 */
export const SSH_HOST_PATTERN = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@)?[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A human-readable reason a hub target is unusable, or null. Pure, so the settings UI and the main process agree. */
export function hubTargetProblem(value: unknown): string | null {
  const target = value as { kind?: unknown; path?: unknown; host?: unknown } | null;
  if (!target || typeof target !== "object") return "No hub is configured";
  if (typeof target.path !== "string" || !target.path.trim()) return "Enter the hub store path";
  if (CONTROL.test(target.path)) return "The hub path contains a control character (newline, tab or NUL)";
  if (target.kind === "fs") return /^(?:\/|[A-Za-z]:[\\/])/.test(target.path) ? null : "The hub folder must be an absolute path";
  if (target.kind === "ssh") {
    if (typeof target.host !== "string" || !SSH_HOST_PATTERN.test(target.host)) return "Enter a valid ssh host: a host name or ~/.ssh/config alias, optionally user@host (no spaces, quotes or leading dash)";
    if (target.path.split("/").includes("..")) return "The hub path on the ssh host must not contain '..'";
    return null;
  }
  return "Unknown hub kind";
}

/** Result of "Test connection": what was reachable, and what was (not) checked. */
export interface HubProbeResult { vaults: VaultDescriptor[]; detail: string }
