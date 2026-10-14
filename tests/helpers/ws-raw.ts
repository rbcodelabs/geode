import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Socket } from "node:net";

/** A deliberately low-level WebSocket peer for the server tests: it can send frames a real client never would. */
export interface RawUpgrade { status: number; headers: Record<string, string | string[] | undefined>; socket?: Socket }

export function rawUpgrade(port: number, headers: Record<string, string>, options: { key?: string; path?: string } = {}): Promise<RawUpgrade> {
  const key = options.key ?? randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: options.path ?? "/", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key, ...headers } });
    req.on("upgrade", (res, socket) => {
      const expected = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      if (res.headers["sec-websocket-accept"] !== expected) return reject(new Error("bad accept key"));
      resolve({ status: res.statusCode ?? 0, headers: res.headers, socket: socket as Socket });
    });
    req.on("response", res => { res.resume(); resolve({ status: res.statusCode ?? 0, headers: res.headers }); });
    req.on("error", reject);
    req.end();
  });
}

/** Encodes one client frame. `mask: false` produces the protocol violation of an unmasked client frame. */
export function clientFrame(opcode: number, payload: Uint8Array, options: { mask?: boolean; fin?: boolean; declaredLength?: number } = {}): Buffer {
  const length = options.declaredLength ?? payload.length;
  const mask = options.mask !== false;
  const head: number[] = [(options.fin === false ? 0 : 0x80) | opcode];
  const maskBit = mask ? 0x80 : 0;
  if (length < 126) head.push(maskBit | length);
  else if (length < 65536) head.push(maskBit | 126, length >> 8, length & 255);
  else { const ext = Buffer.alloc(8); ext.writeBigUInt64BE(BigInt(length)); head.push(maskBit | 127, ...ext); }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from(head), key, masked]);
}

/** Reads server frames (unmasked) from a socket. */
export class ServerFrames {
  private buffer = Buffer.alloc(0);
  readonly frames: Array<{ opcode: number; payload: Buffer }> = [];
  closedByPeer = false;
  constructor(socket: Socket) {
    socket.on("data", chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(); });
    socket.on("close", () => { this.closedByPeer = true; });
    socket.on("error", () => {});
  }
  private drain() {
    for (;;) {
      if (this.buffer.length < 2) return;
      let len = this.buffer[1] & 0x7f, at = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); at = 10; }
      if (this.buffer.length < at + len) return;
      this.frames.push({ opcode: this.buffer[0] & 0x0f, payload: this.buffer.subarray(at, at + len) });
      this.buffer = this.buffer.subarray(at + len);
    }
  }
  async waitFor(predicate: (f: { opcode: number; payload: Buffer }) => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const hit = this.frames.find(predicate); if (hit) return hit; await new Promise(r => setTimeout(r, 10)); }
    throw new Error("timed out waiting for a server frame");
  }
  async waitForClose(ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end && !this.closedByPeer) await new Promise(r => setTimeout(r, 10));
    if (!this.closedByPeer) throw new Error("server did not close the connection");
  }
}
