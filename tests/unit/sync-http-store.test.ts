import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BytesFrameParser, encodeBytesFrame } from "../../src/shared/store-framing";
import { FrameParser, encodeFrame } from "../../src/sync-node/rpc-framing";
import { HttpStoreProvider, subprotocolsFor, toWebSocketUrl, type WebSocketLike } from "../../src/renderer/sync/http-store";
import { MAX_FRAME_BYTES, WS_SUBPROTOCOL, WS_TOKEN_PREFIX } from "../../src/shared/store-protocol";
import { HTTP_TEST_TOKEN, httpFixture, never, randomBytes, rm, sha, tmpStore, type HttpFixture } from "../helpers/sync-store-harness";

describe("Uint8Array frame parser", () => {
  it("decodes exactly what the Buffer parser decodes, for any chunking, and encodes the same bytes", () => {
    const messages: Array<[Record<string, unknown>, Uint8Array?]> = [
      [{ type: "req", id: 1, method: "hello", params: { name: "héllo \u{1F600} ünïcode" } }],
      [{ type: "req", id: 2, method: "putBlobChunk", params: { upload: "u1" } }, randomBytes(70_000)],
      [{ type: "res", id: 3, ok: true, result: {} }],
      [{ type: "res", id: 4, ok: true, result: { length: 5 } }, new Uint8Array([10, 10, 10, 0, 255])], // body bytes that look like newlines
    ];
    const wire = Buffer.concat(messages.flatMap(([h, b]) => encodeFrame(h, b)));
    const wireBytes = new Uint8Array(wire);
    expect(Buffer.concat(messages.flatMap(([h, b]) => encodeBytesFrame(h, b)).map(p => Buffer.from(p)))).toEqual(wire);
    for (const size of [1, 2, 3, 7, 4096, wire.length]) {
      const a = new FrameParser(), b = new BytesFrameParser(), fa: any[] = [], fb: any[] = [];
      for (let at = 0; at < wire.length; at += size) { a.push(wire.subarray(at, at + size), fa); b.push(wireBytes.subarray(at, at + size), fb); }
      expect(fb.map(f => [f.header, f.body ? Buffer.from(f.body).toString("hex") : undefined])).toEqual(fa.map(f => [f.header, f.body ? f.body.toString("hex") : undefined]));
      expect(b.atBoundary).toBe(true);
    }
  });

  it("names the same violations as the Buffer parser", () => {
    const cases: Array<[string, string]> = [
      ["not json\n", "bad-frame"], ["[1]\n", "bad-frame"], [JSON.stringify({ bytes: -1 }) + "\n", "bad-frame"], [JSON.stringify({ bytes: 1.5 }) + "\n", "bad-frame"],
      [JSON.stringify({ bytes: MAX_FRAME_BYTES + 1 }) + "\n", "frame-too-large"],
    ];
    for (const [text, code] of cases) {
      expect(() => new BytesFrameParser().push(new TextEncoder().encode(text)), text).toThrow(expect.objectContaining({ code }));
      expect(() => new FrameParser().push(Buffer.from(text)), text).toThrow(expect.objectContaining({ code }));
    }
  });
});

describe("hostile URLs and token encoding", () => {
  it("accepts only wss/https (ws/http only for tests), without credentials", () => {
    expect(toWebSocketUrl("https://claude-box.tail1234.ts.net")).toBe("wss://claude-box.tail1234.ts.net/");
    expect(toWebSocketUrl("wss://host:8443/path?x=1#frag")).toBe("wss://host:8443/path?x=1");
    for (const bad of ["http://host", "ws://host", "ftp://host", "javascript:alert(1)", "file:///etc/passwd", "host.example", "", "https://user:pw@host", "wss://"]) {
      expect(() => toWebSocketUrl(bad), bad).toThrow(expect.objectContaining({ code: "invalid-request" }));
    }
    expect(toWebSocketUrl("http://127.0.0.1:1", true)).toBe("ws://127.0.0.1:1/");
  });

  it("puts the token in the sub-protocol list (base64url), never in the URL, and the server decodes it back", () => {
    const token = "pässwörd/+= with spaces \u{1F511}";
    const [name, entry] = subprotocolsFor(token);
    expect(name).toBe(WS_SUBPROTOCOL);
    expect(entry.startsWith(WS_TOKEN_PREFIX)).toBe(true);
    expect(entry.slice(WS_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/); // legal RFC 6455 sub-protocol token characters
    expect(Buffer.from(entry.slice(WS_TOKEN_PREFIX.length), "base64url").toString("utf8")).toBe(token);
    expect(() => subprotocolsFor("")).toThrow(expect.objectContaining({ code: "invalid-request" }));
  });

  it("refuses a hostile URL when the provider is built, before any socket exists", () => {
    let made = 0;
    expect(() => new HttpStoreProvider({ url: "http://evil.example", token: () => "x", webSocket: () => { made++; throw new Error("no"); } })).toThrow(/wss:\/\/ or https:\/\//);
    expect(made).toBe(0);
  });
});

let fixture: HttpFixture | undefined, store: string | undefined;
afterEach(async () => { await fixture?.close(); if (store) rm(store); fixture = undefined; store = undefined; });
const setup = async (options?: Parameters<typeof httpFixture>[1]) => { store = tmpStore(); fixture = await httpFixture(store, options); return { provider: fixture.provider, store }; };
const blobDir = (s: string) => join(s, "blobs");
const settled = async (check: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); return check(); };

describe("authentication seen from the client", () => {
  it("a wrong token surfaces as retryable unavailable naming the likely causes, and nothing is served", async () => {
    const { provider } = await setup({ clientToken: HTTP_TEST_TOKEN + "x" });
    await expect(provider.discover(never)).rejects.toMatchObject({ code: "unavailable", retryable: true, message: expect.stringMatching(/token was refused/) });
    expect(fixture!.server.connections()).toBe(0);
  });

  it("a missing token (secure storage empty) is a non-retryable invalid-request, not a network error", async () => {
    store = tmpStore(); fixture = await httpFixture(store);
    const provider = new HttpStoreProvider({ url: `ws://127.0.0.1:${fixture.server.port}/`, allowInsecure: true, token: () => { throw new Error("secure storage unavailable"); } });
    await expect(provider.discover(never)).rejects.toMatchObject({ code: "invalid-request", retryable: false });
  });

  it("an unreachable host is unavailable", async () => {
    const provider = new HttpStoreProvider({ url: "ws://127.0.0.1:1/", allowInsecure: true, token: () => HTTP_TEST_TOKEN, connectTimeoutMs: 2000 });
    await expect(provider.discover(never)).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("reconnect, replay and cancellation", () => {
  it("after the link drops the next call reconnects, replays hello + open, and the session carries on", async () => {
    const { provider } = await setup();
    const binding = await provider.createVault({ name: "hub", operationId: "op-1" }, never);
    const s = await provider.open({ binding, deviceId: "d" }, never);
    const data = new TextEncoder().encode("hello").buffer as ArrayBuffer, digest = sha(data);
    await s.putBlob({ operationId: "o1", sha256: digest, size: 5, data }, never);
    expect(fixture!.sockets).toHaveLength(1);
    fixture!.sockets[0].close();                       // the phone changed network
    await settled(() => fixture!.server.connections() === 0);
    await s.appendRecord({ schema: 1, vaultId: binding.vaultId, recordId: "r1", operationId: "r1-op", deviceId: "d", entityId: "e1", namespace: "content", parents: [], kind: "file", deleted: false, location: { parentId: null, name: "a.md" }, blob: { id: digest, sha256: digest, size: 5 } } as never, never);
    expect(fixture!.sockets).toHaveLength(2);
    expect(((await s.scan(undefined, never)).records as any[]).map(r => r.recordId)).toEqual(["r1"]);
  });

  it("a connection killed mid-blob fails retryably, leaves nothing published or staged, and the retry completes", async () => {
    const { provider, store: dir } = await setup();
    const binding = await provider.createVault({ name: "hub", operationId: "op-1" }, never);
    const s = await provider.open({ binding, deviceId: "d" }, never);
    const big = randomBytes(12 * 1024 * 1024), data = big.buffer as ArrayBuffer, digest = sha(data);
    const first = s.putBlob({ operationId: "o", sha256: digest, size: data.byteLength, data }, never);
    first.catch(() => {});
    await settled(() => { try { return readdirSync(blobDir(dir)).some(n => n.startsWith(".tmp-")); } catch { return false; } }, 3000);
    fixture!.sockets[0].close();
    await expect(first).rejects.toMatchObject({ code: "unavailable", retryable: true });
    await settled(() => fixture!.server.connections() === 0);
    expect(readdirSync(blobDir(dir))).toEqual([]);   // no published blob, no temp file
    expect(await s.putBlob({ operationId: "o", sha256: digest, size: data.byteLength, data }, never)).toEqual({ id: digest, sha256: digest, size: data.byteLength });
    expect(sha(await s.readBlob({ id: digest, sha256: digest, size: data.byteLength }, never))).toBe(digest);
  }, 60_000);

  it("aborting mid-transfer cancels the upload, leaves no blob, and a retry succeeds", async () => {
    const { provider, store: dir } = await setup();
    const binding = await provider.createVault({ name: "hub", operationId: "op-1" }, never);
    const s = await provider.open({ binding, deviceId: "d" }, never);
    const big = randomBytes(12 * 1024 * 1024), data = big.buffer as ArrayBuffer, digest = sha(data), ctl = new AbortController();
    const pending = s.putBlob({ operationId: "o", sha256: digest, size: data.byteLength, data }, ctl.signal);
    pending.catch(() => {});
    await settled(() => { try { return readdirSync(blobDir(dir)).some(n => n.startsWith(".tmp-")); } catch { return false; } }, 3000);
    ctl.abort();
    await expect(pending).rejects.toBeTruthy();
    await settled(() => readdirSync(blobDir(dir)).length === 0);
    expect(readdirSync(blobDir(dir))).toEqual([]);
    await s.putBlob({ operationId: "o", sha256: digest, size: data.byteLength, data }, never);
    expect(readdirSync(blobDir(dir)).filter(n => !n.startsWith(".tmp-"))).toEqual([digest]);
  }, 60_000);

  it("pipelines concurrent putBlobs over the one connection and they all land", async () => {
    const { provider } = await setup();
    const binding = await provider.createVault({ name: "hub", operationId: "op-1" }, never);
    const s = await provider.open({ binding, deviceId: "d" }, never);
    expect(s.uploadConcurrency).toBe(16);
    const blobs = Array.from({ length: 24 }, (_, i) => new TextEncoder().encode(`blob ${i}`).buffer as ArrayBuffer);
    const refs = await Promise.all(blobs.map((data, i) => s.putBlob({ operationId: `o${i}`, sha256: sha(data), size: data.byteLength, data }, never)));
    expect(refs.map(r => r.sha256)).toEqual(blobs.map(sha));
    expect(fixture!.sockets).toHaveLength(1);
  });
});

/** A scripted socket: the test plays the server. */
class FakeSocket implements WebSocketLike {
  binaryType = "blob"; readyState = 0; bufferedAmount = 0;
  onopen: WebSocketLike["onopen"] = null; onmessage: WebSocketLike["onmessage"] = null; onclose: WebSocketLike["onclose"] = null; onerror: WebSocketLike["onerror"] = null;
  sent: Uint8Array[] = []; closed = false;
  constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); }); }
  send(data: Uint8Array) { this.sent.push(data.slice()); }
  close() { this.closed = true; this.readyState = 3; }
  reply(header: Record<string, unknown>) { this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(header) + "\n").buffer }); }
}

describe("a hostile or broken server", () => {
  const withFake = () => {
    const sockets: FakeSocket[] = [];
    const provider = new HttpStoreProvider({ url: "wss://hub.example/", token: () => HTTP_TEST_TOKEN, webSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; } });
    return { provider, sockets };
  };

  it("an oversize frame declaration kills the connection with frame-too-large", async () => {
    const { provider, sockets } = withFake();
    const call = provider.discover(never);
    await settled(() => sockets[0]?.sent.length > 0);
    sockets[0].reply({ type: "res", id: 1, ok: true, result: {}, bytes: MAX_FRAME_BYTES + 1 });
    await expect(call).rejects.toMatchObject({ code: "frame-too-large" });
    expect(sockets[0].closed).toBe(true);
  });

  it("a text message is a protocol error", async () => {
    const { provider, sockets } = withFake();
    const call = provider.discover(never);
    await settled(() => sockets[0]?.sent.length > 0);
    sockets[0].onmessage?.({ data: "hello" });
    await expect(call).rejects.toMatchObject({ code: "protocol" });
  });

  it("sends the token only as a sub-protocol and requests binary frames", async () => {
    let seen: { url: string; protocols: string[] } | undefined;
    const provider = new HttpStoreProvider({ url: "https://hub.example/x", token: () => HTTP_TEST_TOKEN, webSocket: (url, protocols) => { seen = { url, protocols }; return new FakeSocket(); } });
    provider.discover(never).catch(() => {});
    await settled(() => seen !== undefined);
    expect(seen!.url).toBe("wss://hub.example/x");
    expect(seen!.url).not.toContain(HTTP_TEST_TOKEN);
    expect(seen!.protocols).toEqual(subprotocolsFor(HTTP_TEST_TOKEN));
    await provider.close();
  });
});

describe("browser safety of the client modules", () => {
  it("imports nothing from node: and uses no Buffer", () => {
    for (const file of ["src/renderer/sync/http-store.ts", "src/shared/store-framing.ts", "src/shared/store-protocol.ts", "src/shared/store-errors.ts"]) {
      const source = readFileSync(join(__dirname, "../..", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(source, file).not.toMatch(/from\s*["']node:|require\(|\bBuffer\b|process\./);
    }
  });
});
