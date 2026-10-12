import { APPEND_ONLY_PROTOCOL, SYNC_MAX_FILE_BYTES, type AppendOnlySession, type AppendOnlySyncProvider, type BlobRef, type HistoryRecord, type HistoryScan, type VaultDescriptor } from "../../sync-core/history-types";
import { sha256Hex } from "../../sync-core/ports";
import { BytesFrameParser, encodeBytesFrame, type WireFrame } from "../../shared/store-framing";
import { abortError, isStoreError, SyncStoreError } from "../../shared/store-errors";
import {
  APPEND_BATCH, APPEND_BATCH_JSON_BYTES, CLIENT_CHUNK_BYTES, LEGACY_UPLOADS, MAX_UPLOAD_CONCURRENCY, PROTOCOL_NAME, PROTOCOL_VERSION,
  READ_CONCURRENCY, READ_WINDOW, SCAN_PAGE, WS_SUBPROTOCOL, WS_TOKEN_PREFIX,
} from "../../shared/store-protocol";

/**
 * The hub store over WebSocket, for the renderer (desktop and the iOS web view). Browser-safe on purpose: no node:
 * imports, no Buffer, Uint8Array framing (src/shared/store-framing.ts), crypto.subtle for sha256, and the platform
 * WebSocket. It speaks to `geode-wiki sync serve --http` (src/sync-node/http-serve.ts) and mirrors RpcClient /
 * RpcStoreSession (src/sync-node/rpc-store.ts) one for one: lazy connect, reconnect with hello + open replay, pipelined
 * requests, 4 MiB chunking, and the same named errors, so the history engine cannot tell the transports apart.
 *
 * Authentication: a browser WebSocket cannot set an Authorization header, so the token rides in Sec-WebSocket-Protocol
 * as `bearer.<base64url(token)>` next to the real sub-protocol. It is never put in the URL (logged, kept in history).
 * The server rejects a bad token before the upgrade, which a browser reports only as a failed connection, so a refused
 * token and an unreachable hub both surface as `unavailable` with a message naming both causes.
 */

/** The slice of the WebSocket API used here, so tests (and Capacitor shims) can supply their own. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

export interface HttpStoreOptions {
  /** `wss://` or `https://` URL of the hub (as printed by `tailscale serve`). */
  url: string;
  /** Called at every (re)connect, so a rotated token is picked up without recreating the provider. */
  token: () => string | Promise<string>;
  webSocket?: WebSocketFactory;
  connectTimeoutMs?: number;
  /** Tests only: permits ws:// and http:// (the product accepts wss/https only). */
  allowInsecure?: boolean;
}

const OPEN = 1;
/** Pause writing while this much is queued inside the socket, so a large blob cannot balloon the web view's memory. */
const SEND_HIGH_WATER = 8 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const MAX_TOKEN_BYTES = 4096;

/** `https://` becomes `wss://`; anything but wss/https is refused (ws/http only with `allowInsecure`). */
export function toWebSocketUrl(url: string, allowInsecure = false): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new SyncStoreError("invalid-request", "The hub URL is not a valid URL"); }
  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const insecure = parsed.protocol === "http:" || parsed.protocol === "ws:";
  if (!secure && !(allowInsecure && insecure)) throw new SyncStoreError("invalid-request", "The hub URL must start with wss:// or https://");
  if (parsed.username || parsed.password) throw new SyncStoreError("invalid-request", "The hub URL must not contain credentials");
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;
  parsed.hash = "";
  return parsed.toString();
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
/** The Sec-WebSocket-Protocol list that authenticates a browser WebSocket. */
export function subprotocolsFor(token: string): string[] {
  const bytes = new TextEncoder().encode(token);
  if (bytes.length === 0 || bytes.length > MAX_TOKEN_BYTES) throw new SyncStoreError("invalid-request", "The hub token is empty or too long");
  return [WS_SUBPROTOCOL, WS_TOKEN_PREFIX + base64Url(bytes)];
}

/** What the connected server said it can do in its hello reply. Absent fields mean an older server. */
export interface ServerFeatures { putBlob: boolean; appendRecords: boolean; maxUploads: number }
const LEGACY_FEATURES: ServerFeatures = { putBlob: false, appendRecords: false, maxUploads: LEGACY_UPLOADS };
function parseFeatures(hello: any): ServerFeatures {
  const f = hello?.features;
  return {
    putBlob: f?.putBlob === true,
    appendRecords: f?.appendRecords === true,
    maxUploads: typeof hello?.maxUploads === "number" && Number.isSafeInteger(hello.maxUploads) && hello.maxUploads > 0 ? hello.maxUploads : LEGACY_UPLOADS,
  };
}

interface Pending { resolve(value: { result: any; body?: Uint8Array }): void; reject(error: unknown): void }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

class Connection {
  readonly pending = new Map<number, Pending>();
  dead: SyncStoreError | null = null;
  features: ServerFeatures = LEGACY_FEATURES;
  private seq = 0;
  private fatal: SyncStoreError | null = null;
  private tail: Promise<void> = Promise.resolve();
  private sendFailed = false;
  private readonly parser = new BytesFrameParser();

  constructor(private readonly socket: WebSocketLike, private readonly onDead: () => void) {
    socket.onmessage = event => this.receive(event.data);
    socket.onclose = () => this.fail(this.fatal ?? new SyncStoreError("unavailable", "Store connection closed"));
    socket.onerror = () => this.fail(new SyncStoreError("unavailable", "Store connection lost"));
  }

  private receive(data: unknown): void {
    if (this.dead) return;
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return this.fail(new SyncStoreError("protocol", "The hub sent a text message; expected binary frames"));
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    const frames: WireFrame[] = [];
    let violation: unknown;
    try { this.parser.push(bytes, frames); } catch (error) { violation = error; }
    for (const { header, body } of frames) {
      if (header.type !== "res") continue;
      if (header.id === null || header.id === undefined) { this.fatal = SyncStoreError.fromWire(header.error as never); continue; }
      const entry = this.pending.get(header.id as number);
      if (!entry) continue; // late reply to a request that was aborted locally
      this.pending.delete(header.id as number);
      if (header.ok) entry.resolve({ result: header.result, ...(body ? { body } : {}) });
      else entry.reject(SyncStoreError.fromWire(header.error as never));
    }
    if (violation) this.fail(violation instanceof SyncStoreError && violation.code !== "unavailable" ? violation : new SyncStoreError("unavailable", `Store connection lost: ${(violation as Error).message}`));
  }

  fail(error: SyncStoreError): void {
    if (this.dead) return;
    this.dead = error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.onDead();
    try { this.socket.close(1000); } catch { /* already closed */ }
  }

  /** Serialises sends and waits out the socket's own queue; a failed or closed socket makes later sends no-ops. */
  private send(header: Record<string, unknown>, body?: Uint8Array): Promise<void> {
    const parts = encodeBytesFrame(header, body);
    this.tail = this.tail.then(async () => {
      for (const part of parts) {
        while (!this.dead && this.socket.readyState === OPEN && this.socket.bufferedAmount > SEND_HIGH_WATER) await sleep(5);
        if (this.dead || this.socket.readyState !== OPEN) { this.sendFailed = true; return; }
        try { this.socket.send(part); } catch { this.sendFailed = true; return; }
      }
    });
    return this.tail;
  }

  async request(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined, body?: Uint8Array): Promise<{ result: any; body?: Uint8Array }> {
    if (signal?.aborted) throw abortError(signal);
    if (this.dead) throw this.dead;
    const id = ++this.seq;
    const reply = new Promise<{ result: any; body?: Uint8Array }>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    reply.catch(() => { }); // a failed send below must not leave this rejection unhandled
    const onAbort = () => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      void this.send({ type: "abort", target: id }).catch(() => { });
      entry.reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.send({ type: "req", id, method, params }, body);
      if (this.sendFailed && !this.dead) this.fail(new SyncStoreError("unavailable", "Store connection closed"));
      return await reply;
    } finally { signal?.removeEventListener("abort", onAbort); this.pending.delete(id); }
  }
}

/** Opens one socket and resolves when it is open; a refused token, an unreachable host and a timeout all end as `unavailable`. */
function openSocket(factory: WebSocketFactory, url: string, protocols: string[], timeoutMs: number, signal?: AbortSignal): Promise<WebSocketLike> {
  return new Promise<WebSocketLike>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    let socket: WebSocketLike;
    try { socket = factory(url, protocols); } catch (error) { return reject(new SyncStoreError("unavailable", `Cannot reach store: ${(error as Error).message}`, { cause: error })); }
    socket.binaryType = "arraybuffer";
    let settled = false;
    const settle = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); action(); };
    const fail = (error: unknown) => settle(() => { socket.onopen = socket.onclose = socket.onerror = null; try { socket.close(); } catch { /* never opened */ } reject(error); });
    const onAbort = () => fail(abortError(signal));
    const refused = () => fail(new SyncStoreError("unavailable", "Cannot reach the hub: it is unreachable, the URL is wrong, or the token was refused"));
    const timer = setTimeout(() => fail(new SyncStoreError("unavailable", `Cannot reach the hub: no answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    socket.onopen = () => settle(() => resolve(socket));
    socket.onerror = refused;
    socket.onclose = refused;
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Client for a `geode-wiki sync serve --http` peer. Connects lazily and reconnects after a drop, replaying `hello` and
 * the last `open` so a long-lived session survives a flaky link (an iPhone leaving and re-entering the app, a Wi-Fi
 * change). Every failure caused by the link itself is a retryable `unavailable`. One opened vault session per client.
 */
export class HttpStoreClient {
  private conn: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  /** The connection whose handshake is still running, so close() can end it instead of waiting for a hello that may never come. */
  private handshaking: Connection | null = null;
  private opened: { binding: VaultDescriptor; deviceId: string } | null = null;
  private closed = false;
  /** Features of the most recent connection; the legacy set until one has completed its handshake. */
  lastFeatures: ServerFeatures = LEGACY_FEATURES;
  private readonly url: string;
  constructor(private readonly options: HttpStoreOptions) { this.url = toWebSocketUrl(options.url, options.allowInsecure === true); }

  private async establish(signal?: AbortSignal): Promise<Connection> {
    let token: string;
    try { token = await this.options.token(); } catch (error) { throw new SyncStoreError("invalid-request", `No hub token is available: ${(error as Error).message}`, { cause: error }); }
    const factory = this.options.webSocket ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    const socket = await openSocket(factory, this.url, subprotocolsFor(token), this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, signal);
    const conn = new Connection(socket, () => { if (this.conn === conn) this.conn = null; });
    this.handshaking = conn;
    if (this.closed) conn.fail(new SyncStoreError("unavailable", "Store client closed"));
    try {
      conn.features = parseFeatures((await conn.request("hello", { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION }, signal)).result);
      this.lastFeatures = conn.features;
      if (this.opened) await conn.request("open", { binding: this.opened.binding, deviceId: this.opened.deviceId }, signal);
    } catch (error) { conn.fail(error instanceof SyncStoreError ? error : new SyncStoreError("unavailable", String((error as Error).message))); throw error; }
    finally { if (this.handshaking === conn) this.handshaking = null; }
    return conn;
  }

  private async ensure(signal?: AbortSignal): Promise<Connection> {
    if (this.closed) throw new SyncStoreError("unavailable", "Store client is closed");
    if (this.conn && !this.conn.dead) return this.conn;
    this.connecting ??= this.establish(signal).then(conn => { this.conn = conn; return conn; }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async call(method: string, params: Record<string, unknown>, signal?: AbortSignal, body?: Uint8Array): Promise<{ result: any; body?: Uint8Array }> {
    if (signal?.aborted) throw abortError(signal);
    return (await this.ensure(signal)).request(method, params, signal, body);
  }

  async features(signal?: AbortSignal): Promise<ServerFeatures> { return (await this.ensure(signal)).features; }
  rememberOpen(binding: VaultDescriptor, deviceId: string): void { this.opened = { binding, deviceId }; }

  async close(): Promise<void> {
    this.closed = true;
    const closedError = new SyncStoreError("unavailable", "Store client closed");
    this.handshaking?.fail(closedError);
    this.conn?.fail(closedError);
    (await this.connecting?.catch(() => null))?.fail(closedError);
  }
}

export class HttpStoreSession implements AppendOnlySession {
  constructor(private readonly client: HttpStoreClient) { }

  /** Bounded by the server's open-upload limit (4 on servers that predate the field) and by MAX_UPLOAD_CONCURRENCY. */
  get uploadConcurrency(): number { return Math.max(1, Math.min(MAX_UPLOAD_CONCURRENCY, this.client.lastFeatures.maxUploads)); }
  /** The commit receipt is issued only after the server hashed, fsynced and renamed the bytes, and appendRecord re-checks the blob under the writer lock. */
  readonly commitVerified = true;
  readonly readConcurrency = READ_CONCURRENCY;

  async scan(cursor: string | undefined, signal: AbortSignal): Promise<HistoryScan> {
    const records: unknown[] = [];
    let next = cursor, reset = false, first = true;
    try {
      for (;;) {
        const { result: page } = await this.client.call("scan", { ...(next === undefined ? {} : { cursor: next }), limit: SCAN_PAGE }, signal);
        if (first) { reset = Boolean(page.reset); first = false; }
        records.push(...page.records);
        next = page.cursor;
        if (page.status === "partial") return { status: "partial", records, cursor: next, ...(reset ? { reset } : {}) } as HistoryScan;
        if (!page.more) return { status: "complete", records, cursor: next, ...(reset ? { reset } : {}) } as HistoryScan;
      }
    } catch (error) {
      if (signal.aborted) return { status: "cancelled", records } as HistoryScan;
      if (isStoreError(error, "unavailable")) return { status: "unavailable", records } as HistoryScan;
      throw error;
    }
  }

  async putBlob(input: { operationId: string; sha256: string; size: number; data: ArrayBuffer }, signal: AbortSignal): Promise<BlobRef> {
    if (signal.aborted) throw abortError(signal);
    if (input.data.byteLength !== input.size) throw new SyncStoreError("size-mismatch", "Blob data length differs from the declared size");
    if (input.size > SYNC_MAX_FILE_BYTES) throw new SyncStoreError("too-large", `Blob exceeds ${SYNC_MAX_FILE_BYTES} bytes`);
    if (input.size <= CLIENT_CHUNK_BYTES && (await this.client.features(signal)).putBlob) {
      const { result } = await this.client.call("putBlob", { sha256: input.sha256, size: input.size, operationId: input.operationId }, signal, input.size ? new Uint8Array(input.data) : undefined);
      const ref = result.ref as BlobRef;
      if (ref.sha256 !== input.sha256 || ref.size !== input.size) throw new SyncStoreError("hash-mismatch", "Store returned a receipt for different content");
      return ref;
    }
    const { result: started } = await this.client.call("putBlobStart", { sha256: input.sha256, size: input.size, operationId: input.operationId }, signal);
    const upload = started.upload as string;
    try {
      const bytes = new Uint8Array(input.data);
      for (let offset = 0; offset < bytes.length; offset += CLIENT_CHUNK_BYTES) await this.client.call("putBlobChunk", { upload }, signal, bytes.subarray(offset, Math.min(bytes.length, offset + CLIENT_CHUNK_BYTES)));
      const { result } = await this.client.call("putBlobCommit", { upload }, signal);
      const ref = result.ref as BlobRef;
      if (ref.sha256 !== input.sha256 || ref.size !== input.size) throw new SyncStoreError("hash-mismatch", "Store returned a receipt for different content");
      return ref;
    } catch (error) {
      await this.client.call("putBlobAbort", { upload }).catch(() => {}); // best effort; the server also reaps on disconnect
      throw error;
    }
  }

  async readBlob(ref: BlobRef, signal: AbortSignal): Promise<ArrayBuffer> {
    if (signal.aborted) throw abortError(signal);
    if (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > SYNC_MAX_FILE_BYTES) throw new SyncStoreError("too-large", "Blob reference exceeds the size limit");
    const out = new Uint8Array(ref.size);
    const chunks = Math.ceil(ref.size / CLIENT_CHUNK_BYTES);
    // READ_WINDOW chunk requests of one blob stay in flight over the pipelined connection; memory is the preallocated output.
    const inner = new AbortController();
    const onAbort = () => inner.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    let nextChunk = 0;
    const worker = async () => {
      while (nextChunk < chunks && !inner.signal.aborted) {
        const start = nextChunk++ * CLIENT_CHUNK_BYTES, length = Math.min(CLIENT_CHUNK_BYTES, ref.size - start);
        for (let got = 0; got < length;) {
          const { body } = await this.client.call("readBlobRange", { id: ref.id, offset: start + got, length: length - got }, inner.signal);
          if (!body || !body.length) throw new SyncStoreError("size-mismatch", "Store returned a short blob");
          if (got + body.length > length) throw new SyncStoreError("size-mismatch", "Store returned too many blob bytes");
          out.set(body, start + got); got += body.length;
        }
      }
    };
    try {
      const workers = Array.from({ length: Math.min(READ_WINDOW, chunks) }, () => worker().catch(error => { inner.abort(error); throw error; }));
      const settled = await Promise.allSettled(workers);
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw signal.aborted ? abortError(signal) : failed.reason;
    } finally { signal.removeEventListener("abort", onAbort); inner.abort(); }
    if (await sha256Hex(out.buffer as ArrayBuffer) !== ref.sha256) throw new SyncStoreError("hash-mismatch", "Blob bytes do not match the reference");
    return out.buffer as ArrayBuffer;
  }

  async appendRecord(record: HistoryRecord, signal: AbortSignal): Promise<void> {
    await this.client.call("appendRecord", { record }, signal);
  }

  async appendRecords(records: HistoryRecord[], signal: AbortSignal): Promise<{ appended: number; error?: unknown }> {
    if (signal.aborted) throw abortError(signal);
    let appended = 0;
    const features = await this.client.features(signal);
    for (let start = 0; start < records.length;) {
      // Split by count and by encoded size so one request always fits the header cap.
      let end = start, bytes = 0;
      while (end < records.length && end - start < (features.appendRecords ? APPEND_BATCH : 1) && (end === start || bytes + JSON.stringify(records[end]).length < APPEND_BATCH_JSON_BYTES)) bytes += JSON.stringify(records[end++]).length;
      const batch = records.slice(start, end);
      if (!features.appendRecords) {
        try { await this.appendRecord(batch[0], signal); } catch (error) { if (signal.aborted) throw error; return { appended, error }; }
        appended++; start = end; continue;
      }
      const { result } = await this.client.call("appendRecords", { records: batch }, signal);
      if (typeof result?.appended !== "number" || result.appended < 0 || result.appended > batch.length) throw new SyncStoreError("internal", "Store returned an invalid appendRecords receipt");
      appended += result.appended;
      if (result.error) return { appended, error: SyncStoreError.fromWire(result.error) };
      start = end;
    }
    return { appended };
  }

  async close(): Promise<void> { }
}

export class HttpStoreProvider implements AppendOnlySyncProvider {
  readonly id = "http-store";
  readonly name = "Hub store (WebSocket)";
  readonly protocol = APPEND_ONLY_PROTOCOL;
  readonly capabilities = { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } as const;
  readonly client: HttpStoreClient;
  constructor(options: HttpStoreOptions) { this.client = new HttpStoreClient(options); }

  async discover(signal: AbortSignal): Promise<VaultDescriptor[]> { return (await this.client.call("discover", {}, signal)).result.vaults; }
  async createVault(input: { name: string; operationId: string }, signal: AbortSignal): Promise<VaultDescriptor> { return (await this.client.call("createVault", input, signal)).result.descriptor; }
  async open(context: { binding: VaultDescriptor; deviceId: string }, signal: AbortSignal): Promise<HttpStoreSession> {
    await this.client.call("open", { binding: context.binding, deviceId: context.deviceId }, signal);
    this.client.rememberOpen(context.binding, context.deviceId);
    return new HttpStoreSession(this.client);
  }
  close(): Promise<void> { return this.client.close(); }
}
