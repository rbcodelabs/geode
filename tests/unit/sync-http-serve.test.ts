import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES, WS_SUBPROTOCOL, WS_TOKEN_PREFIX } from "../../src/shared/store-protocol";
import { parseListenAddress, readTokenFile, startHttpStoreServer, type HttpStoreServer } from "../../src/sync-node/index";
import { clientFrame, rawUpgrade, ServerFrames } from "../helpers/ws-raw";
import { rm, tmpStore } from "../helpers/sync-store-harness";

const TOKEN = "t".repeat(8) + "-correct-horse-battery-staple";
const subprotocols = (token: string) => `${WS_SUBPROTOCOL}, ${WS_TOKEN_PREFIX}${Buffer.from(token).toString("base64url")}`;
const hello = Buffer.from(JSON.stringify({ type: "req", id: 1, method: "hello", params: { protocol: "geode-store-rpc", version: 1 } }) + "\n");

let store: string, server: HttpStoreServer, logs: string[];
beforeEach(async () => { store = tmpStore(); logs = []; server = await startHttpStoreServer({ store, token: TOKEN, port: 0, log: m => logs.push(m), pingIntervalMs: 60_000 }); });
afterEach(async () => { await server.close(); rm(store); });

describe("authentication happens before the upgrade", () => {
  it("rejects a missing, wrong or URL-borne token with 401 and no upgrade", async () => {
    expect((await rawUpgrade(server.port, {})).status).toBe(401);
    expect((await rawUpgrade(server.port, { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await rawUpgrade(server.port, { "Sec-WebSocket-Protocol": subprotocols("nope") })).status).toBe(401);
    expect((await rawUpgrade(server.port, {}, { path: `/?token=${TOKEN}` })).status).toBe(401);
    expect((await rawUpgrade(server.port, { Authorization: `Bearer ${TOKEN.slice(0, -1)}` })).status).toBe(401);
    expect(server.connections()).toBe(0);
  });

  it("accepts the bearer header (CLI clients) and the sub-protocol token (browsers), and never echoes the token", async () => {
    const viaHeader = await rawUpgrade(server.port, { Authorization: `Bearer ${TOKEN}` });
    expect(viaHeader.status).toBe(101);
    expect(viaHeader.headers["sec-websocket-protocol"]).toBeUndefined();
    viaHeader.socket!.destroy();
    const viaProtocol = await rawUpgrade(server.port, { "Sec-WebSocket-Protocol": subprotocols(TOKEN) });
    expect(viaProtocol.status).toBe(101);
    expect(viaProtocol.headers["sec-websocket-protocol"]).toBe(WS_SUBPROTOCOL);
    viaProtocol.socket!.destroy();
  });

  it("answers a plain HTTP request without revealing anything, and refuses a bad upgrade after auth", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(426);
    expect(await res.text()).toBe("");
    expect((await rawUpgrade(server.port, { Authorization: `Bearer ${TOKEN}`, "Sec-WebSocket-Version": "8" })).status).toBe(426);
    expect((await rawUpgrade(server.port, { Authorization: `Bearer ${TOKEN}` }, { key: "short" })).status).toBe(400);
    expect((await rawUpgrade(server.port, { Authorization: `Bearer ${TOKEN}`, "Sec-WebSocket-Protocol": "other.v9" })).status).toBe(400);
  });

  it("caps concurrent connections", async () => {
    const limited = await startHttpStoreServer({ store, token: TOKEN, port: 0, maxConnections: 1 });
    try {
      const first = await rawUpgrade(limited.port, { Authorization: `Bearer ${TOKEN}` });
      expect(first.status).toBe(101);
      expect((await rawUpgrade(limited.port, { Authorization: `Bearer ${TOKEN}` })).status).toBe(503);
      first.socket!.destroy();
    } finally { await limited.close(); }
  });
});

describe("one connection is one serveStore session", () => {
  const connect = async () => {
    const up = await rawUpgrade(server.port, { "Sec-WebSocket-Protocol": subprotocols(TOKEN) });
    return { socket: up.socket!, frames: new ServerFrames(up.socket!) };
  };

  it("answers hello with the protocol limits, whether the request arrives whole or split across frames", async () => {
    const { socket, frames } = await connect();
    socket.write(clientFrame(2, hello.subarray(0, 10), { fin: false }));
    socket.write(clientFrame(0, hello.subarray(10)));
    const reply = await frames.waitFor(f => f.opcode === 2);
    const header = JSON.parse(reply.payload.toString("utf8"));
    expect(header).toMatchObject({ type: "res", id: 1, ok: true, result: { protocol: "geode-store-rpc", version: 1, maxFrameBytes: MAX_FRAME_BYTES } });
    socket.destroy();
  });

  it("answers ping with pong and closes cleanly on a close frame", async () => {
    const { socket, frames } = await connect();
    socket.write(clientFrame(9, Buffer.from("hi")));
    expect((await frames.waitFor(f => f.opcode === 10)).payload.toString()).toBe("hi");
    socket.write(clientFrame(8, Buffer.from([0x03, 0xe8])));
    const close = await frames.waitFor(f => f.opcode === 8);
    expect(close.payload.readUInt16BE(0)).toBe(1000);
    await frames.waitForClose();
  });

  it("closes 1002 on an unmasked client frame and 1003 on a text frame", async () => {
    for (const [frame, code] of [[clientFrame(2, hello, { mask: false }), 1002], [clientFrame(1, Buffer.from("hi")), 1003]] as const) {
      const { socket, frames } = await connect();
      socket.write(frame);
      expect((await frames.waitFor(f => f.opcode === 8)).payload.readUInt16BE(0)).toBe(code);
      socket.destroy();
    }
  });

  it("closes 1009 on an oversize WebSocket frame before reading its payload", async () => {
    const { socket, frames } = await connect();
    socket.write(clientFrame(2, Buffer.alloc(0), { declaredLength: 64 * 1024 * 1024 }).subarray(0, 14));
    expect((await frames.waitFor(f => f.opcode === 8)).payload.readUInt16BE(0)).toBe(1009);
    socket.destroy();
  });

  it("names an oversize store frame (frame-too-large) and then closes, like the stdio transport", async () => {
    const { socket, frames } = await connect();
    socket.write(clientFrame(2, Buffer.from(JSON.stringify({ type: "req", id: 1, method: "hello", params: { protocol: "geode-store-rpc", version: 1 }, bytes: MAX_FRAME_BYTES + 1 }) + "\n")));
    const reply = await frames.waitFor(f => f.opcode === 2);
    expect(JSON.parse(reply.payload.toString("utf8"))).toMatchObject({ type: "res", id: null, ok: false, error: { code: "frame-too-large" } });
    await frames.waitFor(f => f.opcode === 8);
    await frames.waitForClose();
  });

  it("discards a half-finished upload when the client vanishes mid-blob", async () => {
    const { socket, frames } = await connect();
    const line = (o: object) => Buffer.from(JSON.stringify(o) + "\n");
    socket.write(clientFrame(2, hello));
    socket.write(clientFrame(2, line({ type: "req", id: 2, method: "createVault", params: { name: "hub", operationId: "o" } })));
    await frames.waitFor(f => f.opcode === 2 && JSON.parse(f.payload.toString()).id === 2);
    socket.write(clientFrame(2, line({ type: "req", id: 3, method: "open", params: { binding: JSON.parse((frames.frames.find(f => f.opcode === 2 && JSON.parse(f.payload.toString()).id === 2)!.payload.toString())).result.descriptor, deviceId: "d" } })));
    await frames.waitFor(f => f.opcode === 2 && JSON.parse(f.payload.toString()).id === 3);
    const sha = "a".repeat(64);
    socket.write(clientFrame(2, line({ type: "req", id: 4, method: "putBlobStart", params: { sha256: sha, size: 10 } })));
    await frames.waitFor(f => f.opcode === 2 && JSON.parse(f.payload.toString()).id === 4);
    const chunk = Buffer.concat([line({ type: "req", id: 5, method: "putBlobChunk", params: { upload: "u1" }, bytes: 4 }), Buffer.from("abcd")]);
    socket.write(clientFrame(2, chunk));
    await frames.waitFor(f => f.opcode === 2 && JSON.parse(f.payload.toString()).id === 5);
    socket.destroy();
    for (let i = 0; i < 100 && server.connections() > 0; i++) await new Promise(r => setTimeout(r, 20));
    expect(server.connections()).toBe(0);
    expect(readdirSync(join(store, "blobs")).filter(n => !n.startsWith(".tmp-"))).toEqual([]);
    expect(readdirSync(join(store, "blobs")).filter(n => n.startsWith(".tmp-"))).toEqual([]);
  });

  it("close() ends open sessions with 1001", async () => {
    const { socket, frames } = await connect();
    await server.close();
    expect((await frames.waitFor(f => f.opcode === 8)).payload.readUInt16BE(0)).toBe(1001);
    socket.destroy();
    server = await startHttpStoreServer({ store, token: TOKEN, port: 0 }); // afterEach closes it
  });
});

describe("configuration", () => {
  it("refuses a short token", async () => {
    await expect(startHttpStoreServer({ store, token: "short", port: 0 })).rejects.toThrow(/at least 24/);
  });
  it("reads and validates a token file", () => {
    const file = join(store, "token");
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    expect(readTokenFile(file)).toBe(TOKEN);
    writeFileSync(file, "tiny\n");
    expect(() => readTokenFile(file)).toThrow(/at least 24/);
    expect(() => readTokenFile(join(store, "missing"))).toThrow(/Cannot read token file/);
    writeFileSync(file, `${TOKEN}\n`); chmodSync(file, 0o644);
    const seen: string[] = []; readTokenFile(file, m => seen.push(m));
    expect(seen.join()).toMatch(/chmod 600/);
  });
  it("parses listen addresses", () => {
    expect(parseListenAddress("127.0.0.1:9000")).toEqual({ host: "127.0.0.1", port: 9000 });
    expect(parseListenAddress(":9000")).toEqual({ host: "127.0.0.1", port: 9000 });
    expect(parseListenAddress("9000")).toEqual({ host: "127.0.0.1", port: 9000 });
    expect(parseListenAddress("[::1]:9000")).toEqual({ host: "::1", port: 9000 });
    expect(parseListenAddress("claude-box:8787")).toEqual({ host: "claude-box", port: 8787 });
    for (const bad of ["", "host", "host:99999", "a b:1", "host:port"]) expect(() => parseListenAddress(bad)).toThrow(/--listen/);
  });
});
