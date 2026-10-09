import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { APPEND_ONLY_PROTOCOL, SYNC_MAX_FILE_BYTES, type AppendOnlySession, type AppendOnlySyncProvider, type BlobRef, type HistoryRecord, type HistoryScan, type VaultDescriptor } from "../sync-core/history-types";
import { FrameParser, FrameWriter, type Frame, PROTOCOL_NAME, PROTOCOL_VERSION, type WritableLike } from "./rpc-framing";
import { abortError, isStoreError, SyncStoreError } from "./store-errors";

/** One connected pair of byte streams to a `serveStore` peer. */
export interface StoreTransport {
  /** Bytes coming from the server (its stdout). */
  input: AsyncIterable<Uint8Array>;
  /** Bytes going to the server (its stdin). */
  output: WritableLike;
  /** Tears the connection down (kills the child / ends the streams). Idempotent. */
  close(): void | Promise<void>;
}

const CHUNK = 4 * 1024 * 1024;
const SCAN_PAGE = 200;

interface Pending { resolve(value: { result: any; body?: Buffer }): void; reject(error: unknown): void }

class Connection {
  readonly pending = new Map<number, Pending>();
  readonly writer: FrameWriter;
  dead: SyncStoreError | null = null;
  private seq = 0;
  private fatal: SyncStoreError | null = null;
  constructor(readonly transport: StoreTransport, private readonly onDead: () => void) {
    this.writer = new FrameWriter(transport.output);
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const parser = new FrameParser();
    try {
      for await (const chunk of this.transport.input) {
        const frames: Frame[] = [];
        let violation: unknown;
        try { parser.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), frames); } catch (error) { violation = error; }
        for (const { header, body } of frames) {
          if (header.type !== "res") continue;
          if (header.id === null || header.id === undefined) { this.fatal = SyncStoreError.fromWire(header.error as never); continue; }
          const entry = this.pending.get(header.id as number);
          if (!entry) continue; // late reply to a request that was aborted locally
          this.pending.delete(header.id as number);
          if (header.ok) entry.resolve({ result: header.result, ...(body ? { body } : {}) });
          else entry.reject(SyncStoreError.fromWire(header.error as never));
        }
        if (violation) throw violation;
      }
      this.fail(this.fatal ?? new SyncStoreError("unavailable", "Store connection closed"));
    } catch (error) {
      this.fail(error instanceof SyncStoreError && error.code !== "unavailable" ? error : new SyncStoreError("unavailable", `Store connection lost: ${(error as Error).message}`));
    }
  }

  fail(error: SyncStoreError): void {
    if (this.dead) return;
    this.dead = error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.onDead();
    void Promise.resolve(this.transport.close()).catch(() => {});
  }

  async request(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined, body?: Uint8Array): Promise<{ result: any; body?: Buffer }> {
    if (signal?.aborted) throw abortError(signal);
    if (this.dead) throw this.dead;
    const id = ++this.seq;
    const reply = new Promise<{ result: any; body?: Buffer }>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    reply.catch(() => { }); // a failed send below must not leave this rejection unhandled
    const onAbort = () => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      void this.writer.send({ type: "abort", target: id }).catch(() => { });
      entry.reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.writer.send({ type: "req", id, method, params }, body);
      if (this.writer.closed && !this.dead) this.fail(new SyncStoreError("unavailable", "Store connection closed"));
      return await reply;
    } finally { signal?.removeEventListener("abort", onAbort); this.pending.delete(id); }
  }
}

/**
 * Client for a `serveStore` peer. Connects lazily and reconnects after a drop,
 * replaying `hello` and the last `open` so a long-lived session survives a flaky
 * link. Every failure caused by the link itself is a retryable `unavailable`.
 * One opened vault session per client.
 */
export class RpcClient {
  private conn: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private opened: { binding: VaultDescriptor; deviceId: string } | null = null;
  private closed = false;
  constructor(private readonly connect: () => Promise<StoreTransport> | StoreTransport) { }

  private async establish(signal?: AbortSignal): Promise<Connection> {
    let transport: StoreTransport;
    try { transport = await this.connect(); } catch (error) { throw new SyncStoreError("unavailable", `Cannot reach store: ${(error as Error).message}`, { cause: error }); }
    const conn = new Connection(transport, () => { if (this.conn === conn) this.conn = null; });
    try {
      await conn.request("hello", { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION }, signal);
      if (this.opened) await conn.request("open", { binding: this.opened.binding, deviceId: this.opened.deviceId }, signal);
    } catch (error) { conn.fail(error instanceof SyncStoreError ? error : new SyncStoreError("unavailable", String((error as Error).message))); throw error; }
    return conn;
  }

  private async ensure(signal?: AbortSignal): Promise<Connection> {
    if (this.closed) throw new SyncStoreError("unavailable", "Store client is closed");
    if (this.conn && !this.conn.dead) return this.conn;
    this.connecting ??= this.establish(signal).then(conn => { this.conn = conn; return conn; }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async call(method: string, params: Record<string, unknown>, signal?: AbortSignal, body?: Uint8Array): Promise<{ result: any; body?: Buffer }> {
    if (signal?.aborted) throw abortError(signal);
    return (await this.ensure(signal)).request(method, params, signal, body);
  }

  rememberOpen(binding: VaultDescriptor, deviceId: string): void { this.opened = { binding, deviceId }; }

  async close(): Promise<void> {
    this.closed = true;
    const conn = this.conn ?? await this.connecting?.catch(() => null);
    conn?.fail(new SyncStoreError("unavailable", "Store client closed"));
  }
}

export class RpcStoreSession implements AppendOnlySession {
  constructor(private readonly client: RpcClient) { }

  async scan(cursor: string | undefined, signal: AbortSignal): Promise<HistoryScan> {
    const records: unknown[] = [];
    let next = cursor, reset = false, first = true;
    try {
      for (;;) {
        const { result: page } = await this.client.call("scan", { ...(next === undefined ? {} : { cursor: next }), limit: SCAN_PAGE }, signal);
        if (first) { reset = Boolean(page.reset); first = false; }
        records.push(...page.records);
        next = page.cursor;
        if (page.status === "partial") return { status: "partial", records, cursor: next, ...(reset ? { reset } : {}) };
        if (!page.more) return { status: "complete", records, cursor: next, ...(reset ? { reset } : {}) };
      }
    } catch (error) {
      if (signal.aborted) return { status: "cancelled", records };
      if (isStoreError(error, "unavailable")) return { status: "unavailable", records };
      throw error;
    }
  }

  async putBlob(input: { operationId: string; sha256: string; size: number; data: ArrayBuffer }, signal: AbortSignal): Promise<BlobRef> {
    if (signal.aborted) throw abortError(signal);
    if (input.data.byteLength !== input.size) throw new SyncStoreError("size-mismatch", "Blob data length differs from the declared size");
    if (input.size > SYNC_MAX_FILE_BYTES) throw new SyncStoreError("too-large", `Blob exceeds ${SYNC_MAX_FILE_BYTES} bytes`);
    const { result: started } = await this.client.call("putBlobStart", { sha256: input.sha256, size: input.size, operationId: input.operationId }, signal);
    const upload = started.upload as string;
    try {
      const bytes = new Uint8Array(input.data);
      for (let offset = 0; offset < bytes.length; offset += CHUNK) await this.client.call("putBlobChunk", { upload }, signal, bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK)));
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
    const out = new Uint8Array(ref.size), hash = createHash("sha256");
    for (let offset = 0; offset < ref.size;) {
      const { body } = await this.client.call("readBlobRange", { id: ref.id, offset, length: Math.min(CHUNK, ref.size - offset) }, signal);
      if (!body || !body.length) throw new SyncStoreError("size-mismatch", "Store returned a short blob");
      if (offset + body.length > ref.size) throw new SyncStoreError("size-mismatch", "Store returned too many blob bytes");
      out.set(body, offset); hash.update(body); offset += body.length;
    }
    if (hash.digest("hex") !== ref.sha256) throw new SyncStoreError("hash-mismatch", "Blob bytes do not match the reference");
    return out.buffer;
  }

  async appendRecord(record: HistoryRecord, signal: AbortSignal): Promise<void> {
    await this.client.call("appendRecord", { record }, signal);
  }

  async close(): Promise<void> { }
}

export class RpcStoreProvider implements AppendOnlySyncProvider {
  readonly id = "rpc-store";
  readonly name = "Hub store (stdio)";
  readonly protocol = APPEND_ONLY_PROTOCOL;
  readonly capabilities = { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 } as const;
  readonly client: RpcClient;
  constructor(connect: () => Promise<StoreTransport> | StoreTransport) { this.client = new RpcClient(connect); }

  async discover(signal: AbortSignal): Promise<VaultDescriptor[]> { return (await this.client.call("discover", {}, signal)).result.vaults; }
  async createVault(input: { name: string; operationId: string }, signal: AbortSignal): Promise<VaultDescriptor> { return (await this.client.call("createVault", input, signal)).result.descriptor; }
  async open(context: { binding: VaultDescriptor; deviceId: string }, signal: AbortSignal): Promise<RpcStoreSession> {
    await this.client.call("open", { binding: context.binding, deviceId: context.deviceId }, signal);
    this.client.rememberOpen(context.binding, context.deviceId);
    return new RpcStoreSession(this.client);
  }
  close(): Promise<void> { return this.client.close(); }
}

export interface SpawnCommand { file: string; args: string[] }

/** Spawns a server process and exposes its stdio as a transport. stderr lines go to `onStderr`. */
export function spawnTransport(command: SpawnCommand, onStderr?: (line: string) => void): StoreTransport {
  const child = spawn(command.file, command.args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => { });
  child.on("error", () => { });
  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    if (!onStderr) return;
    tail += text;
    const lines = tail.split("\n"); tail = lines.pop() ?? "";
    for (const line of lines) onStderr(line);
  });
  return { input: child.stdout, output: child.stdin, close: () => { child.stdin.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); } };
}

const SAFE_HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@:%\[\]-]*$/;
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Hub over ssh: `ssh -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4
 * <host> geode-wiki sync serve --store <path>`. A dead link is noticed by ssh within
 * ~60s (15s x 4) and surfaces as `unavailable`; the next call respawns ssh.
 * `command` replaces the whole invocation (tests run the server directly).
 */
export function spawnSshStore(options: { host: string; storePath: string; sshOptions?: string[]; command?: SpawnCommand; onStderr?: (line: string) => void }): RpcStoreProvider {
  if (!options.command && !SAFE_HOST.test(options.host)) throw new SyncStoreError("invalid-request", "Invalid ssh host");
  const command: SpawnCommand = options.command ?? {
    file: "ssh",
    args: ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", ...(options.sshOptions ?? []), options.host, `geode-wiki sync serve --store ${shellQuote(options.storePath)}`],
  };
  return new RpcStoreProvider(() => spawnTransport(command, options.onStderr));
}
