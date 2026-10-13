import { createHash, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { MAX_FRAME_BYTES, MAX_HEADER_BYTES, WS_SUBPROTOCOL, WS_TOKEN_PREFIX } from "../shared/store-protocol";
import { serveStore } from "./serve";
import type { WritableLike } from "./rpc-framing";

/**
 * The hub store over WebSocket (docs/design/app-hub-sync-provider.md, "HTTPS hub").
 *
 * One WebSocket connection is exactly one `serveStore` session speaking the unchanged JSON-lines + binary framing: the
 * WebSocket is only a byte pipe (message boundaries carry no meaning, the framing parser reassembles), so every limit and
 * every error code of the stdio transport applies as is. TLS is not terminated here: bind to loopback and put
 * `tailscale serve` (or any TLS proxy) in front, which is why the default host is 127.0.0.1.
 *
 * Authentication happens BEFORE the upgrade, in constant time, and an unauthenticated peer learns nothing else about the
 * server (401, no body). The token comes from `Authorization: Bearer <token>` (CLI and Node clients) or from a
 * `Sec-WebSocket-Protocol` entry `bearer.<base64url(token)>` next to `geode-store.v1` (browsers and WKWebView cannot set
 * headers on a WebSocket). It is never accepted from the URL, because URLs are logged and kept in history; the server
 * never echoes the token entry back. Minimal RFC 6455 is implemented here (no dependency): masked client frames,
 * fragmentation, ping/pong, close; no extensions, no text frames.
 */
export const MIN_TOKEN_CHARS = 24;
/** Largest WebSocket frame accepted (a full header line plus a full binary frame). Larger declared lengths close 1009 before any payload is read. */
export const MAX_WS_FRAME_BYTES = MAX_HEADER_BYTES + MAX_FRAME_BYTES;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_CONNECTIONS = 8;
const DEFAULT_PING_MS = 25_000;

export interface HttpStoreServerOptions {
  store: string;
  /** Shared secret; at least MIN_TOKEN_CHARS characters. */
  token: string;
  host?: string;
  /** 0 picks a free port (tests). */
  port?: number;
  maxConnections?: number;
  pingIntervalMs?: number;
  log?: (message: string) => void;
}
export interface HttpStoreServer {
  readonly host: string;
  readonly port: number;
  connections(): number;
  /** Stops listening, closes every connection (1001) and resolves once every session has finished and cleaned up. */
  close(): Promise<void>;
}

/** Reads and validates a token file: trimmed, long enough, and a warning when other users can read it. */
export function readTokenFile(path: string, log: (message: string) => void = () => {}): string {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) { throw new Error(`Cannot read token file ${path}: ${(error as Error).message}`); }
  const token = text.trim();
  if (token.length < MIN_TOKEN_CHARS) throw new Error(`The token in ${path} must be at least ${MIN_TOKEN_CHARS} characters (try: openssl rand -base64 32)`);
  try { if (statSync(path).mode & 0o077) log(`warning: ${path} is readable by other users; chmod 600 it`); } catch { /* best effort */ }
  return token;
}

/** `host:port`, `:port` or `port`. IPv6 literals are written `[::1]:8787`. */
export function parseListenAddress(value: string, defaults = { host: "127.0.0.1", port: 8787 }): { host: string; port: number } {
  const m = /^(?:(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]*):)?(\d{1,5})$/.exec(value.trim());
  if (!m) throw new Error(`--listen must look like host:port (got "${value}")`);
  const port = Number(m[2]);
  if (port > 65535) throw new Error(`--listen port ${port} is out of range`);
  const host = m[1] ? m[1].replace(/^\[|\]$/g, "") : defaults.host;
  return { host: host || defaults.host, port };
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();
function tokenMatches(expected: Buffer, candidate: string): boolean { return timingSafeEqual(expected, sha256(candidate)); }

function offeredToken(request: IncomingMessage): { token: string | null; protocols: string[] } {
  const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(p => p.trim()).filter(Boolean);
  const auth = /^Bearer[ ]+(\S+)$/i.exec(String(request.headers.authorization ?? ""));
  if (auth) return { token: auth[1], protocols };
  const entry = protocols.find(p => p.startsWith(WS_TOKEN_PREFIX));
  const encoded = entry?.slice(WS_TOKEN_PREFIX.length);
  return { token: encoded && /^[A-Za-z0-9_-]+$/.test(encoded) ? Buffer.from(encoded, "base64url").toString("utf8") : null, protocols };
}

function reject(socket: Socket, status: number, reason: string, headers: Record<string, string> = {}): void {
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
}

/** Protocol violation by the peer: carries the close code to answer with. */
class WsViolation extends Error { constructor(readonly code: number, message: string) { super(message); } }

/** Incremental RFC 6455 reader for client->server frames. Data payload is streamed to `onData` as it arrives (never buffered whole). */
class WsReader {
  private head = Buffer.alloc(14);
  private headLen = 0;
  private remaining = 0;
  private opcode = 0;
  private mask = Buffer.alloc(4);
  private maskPos = 0;
  private control: Buffer[] = [];
  private fragmenting = false;
  constructor(private readonly handlers: { onData(payload: Buffer): void; onPing(payload: Buffer): void; onClose(code: number): void }) {}

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining === 0) {
        offset += this.readHead(chunk, offset);
        if (this.remaining === 0 && this.headLen === 0) this.finishFrame(); // zero-length frame completed by readHead
        continue;
      }
      const take = Math.min(this.remaining, chunk.length - offset);
      const part = chunk.subarray(offset, offset + take);
      for (let i = 0; i < take; i++) part[i] ^= this.mask[(this.maskPos + i) & 3];
      this.maskPos += take; this.remaining -= take; offset += take;
      if (this.opcode >= 8) this.control.push(part); else this.handlers.onData(part);
      if (this.remaining === 0) this.finishFrame();
    }
  }

  /** Consumes header bytes; returns how many were used. Sets `remaining` (and resets headLen) once the header is complete. */
  private readHead(chunk: Buffer, offset: number): number {
    let used = 0;
    const need = (): number => {
      if (this.headLen < 2) return 2;
      const len7 = this.head[1] & 0x7f;
      return 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0) + 4;
    };
    while (this.headLen < need() && offset + used < chunk.length) this.head[this.headLen++] = chunk[offset + used++];
    if (this.headLen < need()) return used;
    const b0 = this.head[0], b1 = this.head[1];
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, len7 = b1 & 0x7f;
    if (b0 & 0x70) throw new WsViolation(1002, "reserved bits set");
    if (!(b1 & 0x80)) throw new WsViolation(1002, "client frames must be masked");
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw new WsViolation(1002, "unknown opcode");
    if (opcode === 1) throw new WsViolation(1003, "text frames are not supported");
    let length = len7, at = 2;
    if (len7 === 126) { length = this.head.readUInt16BE(2); at = 4; }
    else if (len7 === 127) {
      if (this.head.readUInt32BE(2) !== 0) throw new WsViolation(1009, "frame too large");
      length = this.head.readUInt32BE(6); at = 10;
    }
    if (opcode >= 8) { if (!fin || length > 125) throw new WsViolation(1002, "invalid control frame"); }
    else {
      if (opcode === 0 ? !this.fragmenting : this.fragmenting) throw new WsViolation(1002, "unexpected continuation state");
      if (length > MAX_WS_FRAME_BYTES) throw new WsViolation(1009, `frame of ${length} bytes exceeds ${MAX_WS_FRAME_BYTES}`);
      this.fragmenting = !fin;
    }
    this.head.copy(this.mask, 0, at, at + 4);
    this.opcode = opcode; this.remaining = length; this.maskPos = 0; this.control = [];
    this.headLen = 0;
    return used;
  }

  private finishFrame(): void {
    if (this.opcode === 9) this.handlers.onPing(Buffer.concat(this.control));
    else if (this.opcode === 8) {
      const body = Buffer.concat(this.control);
      this.handlers.onClose(body.length >= 2 ? body.readUInt16BE(0) : 1005);
    }
    this.control = [];
  }
}

function wsFrameHeader(opcode: number, length: number): Buffer {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length < 65536) { const h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 126; h.writeUInt16BE(length, 2); return h; }
  const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(length, 6); return h;
}

/** serveStore's output: each write becomes one binary WebSocket frame. Honours backpressure through the socket. */
class WsSink extends EventEmitter implements WritableLike {
  writableEnded = false;
  constructor(private readonly socket: Socket) {
    super();
    socket.on("drain", () => this.emit("drain"));
    socket.on("close", () => this.emit("close"));
    socket.on("error", error => this.emit("error", error));
  }
  get destroyed(): boolean { return this.socket.destroyed; }
  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean {
    if (this.writableEnded || this.socket.destroyed) { callback?.(new Error("WebSocket closed")); return false; }
    this.socket.cork();
    this.socket.write(wsFrameHeader(2, chunk.length));
    const ok = this.socket.write(chunk, callback);
    this.socket.uncork();
    return ok;
  }
  /** Sends a close frame and half-closes. Idempotent. */
  close(code: number): void {
    if (this.writableEnded || this.socket.destroyed) return;
    this.writableEnded = true;
    const payload = Buffer.alloc(2); payload.writeUInt16BE(code);
    this.socket.end(Buffer.concat([wsFrameHeader(8, 2), payload]));
    setTimeout(() => this.socket.destroy(), 5_000).unref(); // a peer that never completes the close handshake
  }
  pong(payload: Buffer): void { if (!this.writableEnded && !this.socket.destroyed) this.socket.write(Buffer.concat([wsFrameHeader(10, payload.length), payload])); }
  ping(): void { if (!this.writableEnded && !this.socket.destroyed) this.socket.write(wsFrameHeader(9, 0)); }
}

export function startHttpStoreServer(options: HttpStoreServerOptions): Promise<HttpStoreServer> {
  if (typeof options.token !== "string" || options.token.length < MIN_TOKEN_CHARS) return Promise.reject(new Error(`The hub token must be at least ${MIN_TOKEN_CHARS} characters`));
  const log = options.log ?? (() => {});
  const host = options.host ?? "127.0.0.1";
  const expected = sha256(options.token);
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const pingMs = options.pingIntervalMs ?? DEFAULT_PING_MS;
  const sessions = new Set<{ sink: WsSink; done: Promise<void> }>();

  const server: Server = createServer((_request, response) => {
    // Not a WebSocket upgrade: say nothing about what this is.
    response.writeHead(426, { "Content-Length": "0", Connection: "close", Upgrade: "websocket" }).end();
  });
  server.on("clientError", (_error, socket) => { if (socket.writable) reject(socket as Socket, 400, "Bad Request"); else socket.destroy(); });

  server.on("upgrade", (request, rawSocket) => {
    const socket = rawSocket as Socket;
    socket.on("error", () => { /* per-connection errors are handled through close */ });
    const { token, protocols } = offeredToken(request);
    if (token === null || !tokenMatches(expected, token)) return reject(socket, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
    const key = String(request.headers["sec-websocket-key"] ?? "");
    if (request.method !== "GET" || String(request.headers.upgrade ?? "").toLowerCase() !== "websocket" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return reject(socket, 400, "Bad Request");
    if (request.headers["sec-websocket-version"] !== "13") return reject(socket, 426, "Upgrade Required", { "Sec-WebSocket-Version": "13" });
    const named = protocols.filter(p => !p.startsWith(WS_TOKEN_PREFIX));
    if (named.length > 0 && !named.includes(WS_SUBPROTOCOL)) return reject(socket, 400, "Bad Request");
    if (sessions.size >= maxConnections) return reject(socket, 503, "Service Unavailable", { "Retry-After": "5" });

    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${named.length ? `Sec-WebSocket-Protocol: ${WS_SUBPROTOCOL}\r\n` : ""}\r\n`);
    socket.setTimeout(0); socket.setNoDelay(true);

    const input = new PassThrough();
    const sink = new WsSink(socket);
    let alive = true, finished = false;
    const finish = () => { if (finished) return; finished = true; clearInterval(timer); input.end(); };
    const reader = new WsReader({
      onData: payload => { if (!input.write(payload)) { socket.pause(); input.once("drain", () => socket.resume()); } },
      onPing: payload => sink.pong(payload),
      onClose: () => { sink.close(1000); finish(); },
    });
    socket.on("data", (chunk: Buffer) => {
      if (finished) return;
      alive = true;
      try { reader.push(chunk); } catch (error) {
        const violation = error instanceof WsViolation ? error : new WsViolation(1002, "bad frame");
        log(`closing connection: ${violation.message}`);
        sink.close(violation.code); finish();
      }
    });
    socket.on("close", finish);
    socket.on("end", finish);
    const timer = setInterval(() => { if (!alive) { log("peer unresponsive; dropping connection"); socket.destroy(); return; } alive = false; sink.ping(); }, pingMs);
    timer.unref();

    const entry = { sink, done: Promise.resolve() };
    entry.done = serveStore({ store: options.store, input, output: sink, log: message => log(message) })
      .catch(error => log(`session failed: ${(error as Error).message}`))
      .finally(() => { sink.close(1000); sessions.delete(entry); });
    sessions.add(entry);
  });

  return new Promise<HttpStoreServer>((resolve, reject_) => {
    server.once("error", reject_);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject_);
      server.on("error", error => log(`server error: ${error.message}`));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port ?? 0;
      resolve({
        host, port, connections: () => sessions.size,
        close: async () => {
          const closed = new Promise<void>(done => server.close(() => done()));
          for (const { sink } of sessions) sink.close(1001);
          await Promise.all([...sessions].map(s => s.done));
          server.closeAllConnections();
          await closed;
        },
      });
    });
  });
}
