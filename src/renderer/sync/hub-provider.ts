import { APPEND_ONLY_PROTOCOL, type AppendOnlySession, type AppendOnlySyncProvider, type BlobRef, type HistoryRecord, type HistoryScan, type VaultDescriptor } from "./history-types";
import { canonicalHubUrl, hubTargetProblem, hubTokenKey, type HubConfig, type HubErrorInfo, type HubProbeResult, type HubRequest, type HubResultMap, type HubSyncBridge, type HubTarget } from "../../shared/hub-sync";
import { isStoreError } from "../../shared/store-errors";
import { HttpStoreProvider, type HttpStoreSession, type WebSocketFactory } from "./http-store";

/**
 * Built-in sync provider "Folder, SSH or HTTPS hub": the same hub stores the headless `geode-wiki sync` uses. The history
 * engine stays in the renderer (SyncService). Folder and ssh targets proxy the store's session API over IPC to
 * `src/sync-node/app-hub.ts` in the main process, which owns the filesystem and the ssh child. An HTTPS target
 * (`geode-wiki sync serve --http` behind TLS) needs no main process: the renderer talks WebSocket itself through
 * `./http-store`, which is what lets a phone use it. See docs/design/app-hub-sync-provider.md.
 */
export const HUB_PROVIDER_ID = "geode.hub";
export const HUB_PROVIDER_NAME = "Folder, SSH or HTTPS hub";

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

/** Where the hub token lives: the host's secure storage, never device state and never the vault. */
export interface HubSecretStore {
  /** False when the host has no secure storage; callers must then refuse to take a token rather than keep it elsewhere. */
  readonly available: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface HubProviderOptions {
  secrets?: HubSecretStore;
  /** Test seam: the WebSocket constructor (default: the platform's) and permission to use ws:// (never offered by the settings UI). */
  http?: { webSocket?: WebSocketFactory; allowInsecure?: boolean; connectTimeoutMs?: number };
}

const abortError = () => new DOMException("Sync context changed", "AbortError");

/** Hints that turn a transport failure into something a person can act on. */
function httpHint(code: string): string | undefined {
  if (code === "unavailable") return "Check the hub URL and token, that `geode-wiki sync serve --http` is running on the hub, and that this device can reach it (is Tailscale connected?).";
  if (code === "invalid-request") return "Enter the hub token in Settings > Sync.";
  return undefined;
}
function toHubError(error: unknown): unknown {
  if (!isStoreError(error)) return error;
  if (error.code === "aborted") return abortError(); // same shape the IPC-backed targets reject with
  const hint = httpHint(error.code);
  return new HubSyncError({ code: error.code, message: hint && !/[.!?]$/.test(error.message) ? `${error.message}.` : error.message, ...(hint ? { hint } : {}) });
}
async function translate<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw toHubError(error); }
}

/** Wraps an HttpStoreSession so its failures read like the IPC-backed targets' and its close ends the connection. */
function httpSession(inner: HttpStoreSession, release: () => Promise<void>): AppendOnlySession {
  return {
    scan: (cursor, signal) => translate(() => inner.scan(cursor, signal)),
    putBlob: (input, signal) => translate(() => inner.putBlob(input, signal)),
    readBlob: (ref, signal) => translate(() => inner.readBlob(ref, signal)),
    appendRecord: (record, signal) => translate(() => inner.appendRecord(record, signal)),
    appendRecords: (records, signal) => translate(async () => {
      const result = await inner.appendRecords(records, signal);
      return result.error === undefined ? result : { appended: result.appended, error: toHubError(result.error) };
    }),
    close: async () => { try { await inner.close(); } finally { await release().catch(() => {}); } },
    get uploadConcurrency() { return inner.uploadConcurrency; },
    get readConcurrency() { return inner.readConcurrency; },
    get commitVerified() { return inner.commitVerified; },
  };
}

export class HubSyncProvider implements AppendOnlySyncProvider {
  readonly id = HUB_PROVIDER_ID;
  readonly name = HUB_PROVIDER_NAME;
  readonly protocol = APPEND_ONLY_PROTOCOL;
  readonly capabilities = { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } as const;
  /** Opts into the unattended-run rails (deletion cap, shrunk-scan guard) in SyncService. */
  readonly safetyRails = true as const;

  /**
   * `bridge` serves the folder and ssh targets and exists only where the host has a main process for them (desktop);
   * without it only the HTTPS target is offered. `options.secrets` keeps the HTTPS token.
   */
  constructor(private readonly bridge: HubSyncBridge | undefined, private readonly deviceState: HubDeviceState, private readonly root: () => string, private readonly options: HubProviderOptions = {}) {}

  /** The target kinds this host can reach, in the order the settings UI lists them. */
  get supportedKinds(): ReadonlyArray<HubTarget["kind"]> { return this.bridge ? ["fs", "ssh", "http"] : ["http"]; }
  /** Whether a token can be kept on this host. Without secure storage the HTTPS target cannot be configured. */
  get canStoreToken(): boolean { return this.options.secrets?.available === true; }

  async hasToken(url: string): Promise<boolean> {
    const secrets = this.options.secrets; if (!secrets?.available) return false;
    try { return Boolean(await secrets.get(hubTokenKey(url))); } catch { return false; }
  }
  /** Stores the token for this hub URL's host in secure storage. Refuses (rather than falling back) when there is none. */
  async setToken(url: string, token: string): Promise<void> {
    const secrets = this.options.secrets;
    if (!secrets?.available) throw new HubSyncError({ code: "secure-storage-unavailable", message: "Secure storage is unavailable on this device, so the hub token cannot be saved.", hint: "The token is never kept in the vault or in app settings." });
    const problem = hubTargetProblem({ kind: "http", url }); if (problem) throw new HubSyncError({ code: "invalid-target", message: problem });
    const value = token.trim();
    if (!value) throw new HubSyncError({ code: "invalid-token", message: "Enter the hub token." });
    await secrets.set(hubTokenKey(url), value);
  }
  async clearToken(url: string): Promise<void> { if (this.options.secrets?.available) await this.options.secrets.remove(hubTokenKey(url)); }

  /** A fresh client per operation or opened session (it ends with it): nothing stays connected while sync is idle. */
  private httpProvider(target: Extract<HubTarget, { kind: "http" }>): HttpStoreProvider {
    const secrets = this.options.secrets;
    return new HttpStoreProvider({
      url: target.url,
      token: async () => {
        if (!secrets?.available) throw new Error("secure storage is unavailable on this device");
        const token = await secrets.get(hubTokenKey(target.url));
        if (!token) throw new Error("no token is saved for this hub");
        return token;
      },
      ...this.options.http,
    });
  }

  private async withHttp<T>(target: Extract<HubTarget, { kind: "http" }>, signal: AbortSignal, work: (provider: HttpStoreProvider) => Promise<T>): Promise<T> {
    if (signal.aborted) throw abortError();
    const provider = this.httpProvider(target);
    try { return await translate(() => work(provider)); } finally { await provider.close().catch(() => {}); }
  }

  private configKey(root = this.root()): string { return `sync-hub/config/${root}`; }

  async getConfig(): Promise<HubConfig | null> {
    const value = await this.deviceState.read<HubConfig>(this.configKey());
    if (!value) return null;
    if (value.schema !== 1 || !value.target || (value.target.kind === "http" ? typeof value.target.url !== "string" : typeof (value.target as { path?: unknown }).path !== "string")) throw new Error("Hub configuration is invalid; configure the hub again");
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
    if (config.target.kind === "http") {
      const hubs = await this.withHttp(config.target, signal, provider => provider.discover(signal));
      return { vaults: hubs, detail: "Reached the hub over WebSocket, signed in with the token, and listed its vaults. Whether a new hub can be created there is only known when you create it." };
    }
    return this.invoke({ method: "probe", target: config.target, create: config.create }, signal);
  }
  clearConfig(): Promise<void> { return this.deviceState.remove(this.configKey()); }

  private async requireConfig(): Promise<HubConfig> {
    const config = await this.getConfig();
    if (!config) throw new HubSyncError({ code: "not-configured", message: "No hub is configured yet.", hint: "Enter a hub folder, an ssh host and path, or an HTTPS hub URL in Settings > Sync." });
    return config;
  }

  async discover(signal: AbortSignal): Promise<VaultDescriptor[]> {
    const { target } = await this.requireConfig();
    if (target.kind === "http") return this.withHttp(target, signal, provider => provider.discover(signal));
    return this.invoke({ method: "discover", target }, signal);
  }

  async createVault(input: { name: string; operationId: string }, signal: AbortSignal): Promise<VaultDescriptor> {
    const config = await this.requireConfig();
    // Same guard as `geode-wiki sync init --create`: starting a history in an empty store is explicit.
    if (!config.create) throw new HubSyncError({ code: "create-not-allowed", message: "Creating a new hub vault is switched off.", hint: "Tick \"Create the hub if it is missing\" to start a new history in this store, or join the existing vault." });
    if (config.target.kind === "http") return this.withHttp(config.target, signal, provider => provider.createVault(input, signal));
    return this.invoke({ method: "createVault", target: config.target, input }, signal);
  }

  async open(context: { binding: VaultDescriptor; deviceId: string }, signal: AbortSignal): Promise<AppendOnlySession> {
    const config = await this.requireConfig();
    if (config.target.kind === "http") {
      // The connection belongs to this session: it is dropped when the session closes, and re-made (replaying hello + open) if the link drops.
      if (signal.aborted) throw abortError();
      const provider = this.httpProvider(config.target);
      try { return httpSession(await translate(() => provider.open(context, signal)), () => provider.close()); }
      catch (error) { await provider.close().catch(() => {}); throw error; }
    }
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
    if (!this.bridge) return Promise.reject(new HubSyncError({ code: "unsupported-target", message: "Folder and ssh hubs are not available on this device.", hint: "Use an HTTPS hub." }));
    const bridge = this.bridge;
    const requestId = crypto.randomUUID();
    return new Promise<HubResultMap[M]>((resolve, reject) => {
      const onAbort = () => { bridge.abort(requestId); reject(abortError()); };
      signal.addEventListener("abort", onAbort, { once: true });
      bridge.call(request, requestId).then(response => {
        if (signal.aborted) return;
        if (response.ok) resolve(response.value as HubResultMap[M]); else reject(new HubSyncError(response.error));
      }, error => { if (!signal.aborted) reject(error instanceof Error ? error : new Error(String(error))); })
        .finally(() => signal.removeEventListener("abort", onAbort));
    });
  }
}

export function normaliseTarget(target: HubTarget): HubTarget {
  if (target.kind === "http") {
    // Canonicalise only a URL that is valid; an invalid one is kept (trimmed) so hubTargetProblem reports it.
    const url = typeof target.url === "string" ? target.url.trim() : "";
    return { kind: "http", url: hubTargetProblem({ kind: "http", url }) ? url : canonicalHubUrl(url) };
  }
  return target.kind === "ssh" ? { kind: "ssh", host: target.host.trim(), path: target.path.trim() } : { kind: "fs", path: target.path.trim() };
}

export function describeHubTarget(target: HubTarget): string {
  if (target.kind === "http") return target.url;
  return target.kind === "fs" ? target.path : `ssh://${target.host}${target.path.startsWith("/") ? "" : "/"}${target.path}`;
}
