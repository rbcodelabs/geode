import { APPEND_ONLY_PROTOCOL, type AppendOnlySession, type AppendOnlySyncProvider, type BlobRef, type HistoryRecord, type HistoryScan, type VaultDescriptor } from "./history-types";
import { hubTargetProblem, type HubConfig, type HubErrorInfo, type HubProbeResult, type HubRequest, type HubResultMap, type HubSyncBridge, type HubTarget } from "../../shared/hub-sync";

/**
 * Built-in sync provider "Folder or SSH hub": the same hub stores the headless `geode-wiki sync` uses, reachable
 * from the desktop app. The history engine stays in the renderer (SyncService); this class only proxies the
 * store's session API over IPC to `src/sync-node/app-hub.ts` in the main process, which owns the filesystem and
 * the ssh child. See docs/design/app-hub-sync-provider.md.
 */
export const HUB_PROVIDER_ID = "geode.hub";
export const HUB_PROVIDER_NAME = "Folder or SSH hub";

/** A failure reported by the main-process hub endpoint, with a stable `code` and a human `hint`. */
export class HubSyncError extends Error {
  readonly code: string; readonly hint?: string;
  constructor(info: HubErrorInfo) { super(info.hint ? `${info.message} ${info.hint}` : info.message); this.name = "HubSyncError"; this.code = info.code; if (info.hint) this.hint = info.hint; }
}

export interface HubDeviceState {
  read<T>(key: string): Promise<T | null>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

const abortError = () => new DOMException("Sync context changed", "AbortError");

export class HubSyncProvider implements AppendOnlySyncProvider {
  readonly id = HUB_PROVIDER_ID;
  readonly name = HUB_PROVIDER_NAME;
  readonly protocol = APPEND_ONLY_PROTOCOL;
  readonly capabilities = { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } as const;
  /** Opts into the unattended-run rails (deletion cap, shrunk-scan guard) in SyncService. */
  readonly safetyRails = true as const;

  constructor(private readonly bridge: HubSyncBridge, private readonly deviceState: HubDeviceState, private readonly root: () => string) {}

  private configKey(root = this.root()): string { return `sync-hub/config/${root}`; }

  async getConfig(): Promise<HubConfig | null> {
    const value = await this.deviceState.read<HubConfig>(this.configKey());
    if (!value) return null;
    if (value.schema !== 1 || !value.target || typeof value.target.path !== "string") throw new Error("Hub configuration is invalid; configure the hub again");
    return value;
  }
  /** Validates (the same strict rules main applies) and saves. Hostile or malformed input is refused here, before any ssh could be spawned. */
  async setConfig(config: HubConfig): Promise<void> {
    const target = normaliseTarget(config.target);
    const problem = hubTargetProblem(target);
    if (problem) throw new HubSyncError({ code: "invalid-target", message: problem });
    await this.deviceState.write(this.configKey(), { schema: 1, target, create: config.create === true } satisfies HubConfig);
  }

  /** "Test connection": reachability and, when creating is on, whether the hub can be created. Creates nothing. */
  async probe(signal: AbortSignal): Promise<HubProbeResult> {
    const config = await this.requireConfig();
    return this.invoke({ method: "probe", target: config.target, create: config.create }, signal);
  }
  clearConfig(): Promise<void> { return this.deviceState.remove(this.configKey()); }

  private async requireConfig(): Promise<HubConfig> {
    const config = await this.getConfig();
    if (!config) throw new HubSyncError({ code: "not-configured", message: "No hub is configured yet.", hint: "Enter a hub folder (or an ssh host and path) in Settings > Sync." });
    return config;
  }

  async discover(signal: AbortSignal): Promise<VaultDescriptor[]> {
    return this.invoke({ method: "discover", target: (await this.requireConfig()).target }, signal);
  }

  async createVault(input: { name: string; operationId: string }, signal: AbortSignal): Promise<VaultDescriptor> {
    const config = await this.requireConfig();
    // Same guard as `geode-wiki sync init --create`: starting a history in an empty store is explicit.
    if (!config.create) throw new HubSyncError({ code: "create-not-allowed", message: "Creating a new hub vault is switched off.", hint: "Tick \"Create the hub if it is missing\" to start a new history in this store, or join the existing vault." });
    return this.invoke({ method: "createVault", target: config.target, input }, signal);
  }

  async open(context: { binding: VaultDescriptor; deviceId: string }, signal: AbortSignal): Promise<AppendOnlySession> {
    const config = await this.requireConfig();
    const reply = await this.invoke({ method: "open", target: config.target, binding: context.binding, deviceId: context.deviceId }, signal);
    const call = (request: HubRequest, callSignal: AbortSignal) => this.invoke(request, callSignal);
    const session: AppendOnlySession = {
      scan: (cursor, s) => call({ method: "scan", sessionId: reply.sessionId, cursor }, s) as Promise<HistoryScan>,
      putBlob: (input, s) => call({ method: "putBlob", sessionId: reply.sessionId, input }, s) as Promise<BlobRef>,
      readBlob: (ref, s) => call({ method: "readBlob", sessionId: reply.sessionId, ref }, s) as Promise<ArrayBuffer>,
      appendRecord: async (record: HistoryRecord, s) => { await call({ method: "appendRecord", sessionId: reply.sessionId, record }, s); },
      close: async () => { try { await this.invoke({ method: "close", sessionId: reply.sessionId }, new AbortController().signal); } catch { /* the window or the session is already gone */ } },
      ...(reply.uploadConcurrency !== undefined ? { uploadConcurrency: reply.uploadConcurrency } : {}),
      ...(reply.readConcurrency !== undefined ? { readConcurrency: reply.readConcurrency } : {}),
      ...(reply.commitVerified !== undefined ? { commitVerified: reply.commitVerified } : {}),
      ...(reply.appendRecords ? {
        appendRecords: async (records: HistoryRecord[], s: AbortSignal) => {
          const result = await call({ method: "appendRecords", sessionId: reply.sessionId, records }, s) as HubResultMap["appendRecords"];
          return { appended: result.appended, ...(result.error ? { error: new HubSyncError(result.error) } : {}) };
        },
      } : {}),
    };
    return session;
  }

  /** One IPC round trip with cancellation. An abort rejects immediately and tells main to stop the work. */
  private invoke<R extends HubRequest>(request: R, signal: AbortSignal): Promise<HubResultMap[R["method"]]> {
    type M = R["method"];
    if (signal.aborted) return Promise.reject(abortError());
    const requestId = crypto.randomUUID();
    return new Promise<HubResultMap[M]>((resolve, reject) => {
      const onAbort = () => { this.bridge.abort(requestId); reject(abortError()); };
      signal.addEventListener("abort", onAbort, { once: true });
      this.bridge.call(request, requestId).then(response => {
        if (signal.aborted) return;
        if (response.ok) resolve(response.value as HubResultMap[M]); else reject(new HubSyncError(response.error));
      }, error => { if (!signal.aborted) reject(error instanceof Error ? error : new Error(String(error))); })
        .finally(() => signal.removeEventListener("abort", onAbort));
    });
  }
}

export function normaliseTarget(target: HubTarget): HubTarget {
  return target.kind === "ssh" ? { kind: "ssh", host: target.host.trim(), path: target.path.trim() } : { kind: "fs", path: target.path.trim() };
}

export function describeHubTarget(target: HubTarget): string {
  return target.kind === "fs" ? target.path : `ssh://${target.host}${target.path.startsWith("/") ? "" : "/"}${target.path}`;
}
