import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { FsStoreProvider, RpcClient, RpcStoreProvider, serveStore, type ServeStats } from "../../src/sync-node/index";
import { currentBootId, withStoreLock } from "../../src/sync-node/store-lock";
import { canonicalJson } from "../../src/sync-node/fs-store";
import { MAX_FRAME_BYTES, MAX_HEADER_BYTES, PROTOCOL_NAME, PROTOCOL_VERSION } from "../../src/sync-node/rpc-framing";
import { SYNC_MAX_FILE_BYTES } from "../../src/sync-core/history-types";
import { bytes, childProvider, cleanBundle, inProcessProvider, never, randomBytes, record, rm, runAppender, sha, spawnServe, tmpStore } from "../helpers/sync-store-harness";

afterAll(() => cleanBundle());
const visibleBlobs = (store: string) => readdirSync(join(store, "blobs")).filter(n => !n.startsWith(".tmp-"));
const tmpFiles = (dir: string) => readdirSync(dir).filter(n => n.startsWith(".tmp-"));
const until = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); return check(); };

async function vault(store: string) {
  const provider = new FsStoreProvider(store), binding = await provider.createVault({ name: "hub", operationId: "op" }, never);
  return { provider, binding, session: await provider.open({ binding, deviceId: "d" }, never) };
}

/** Feeds raw bytes to serveStore and returns every JSON line it wrote back. */
async function rawExchange(store: string, input: Array<Buffer | string>): Promise<{ replies: any[]; logs: string[]; stats: ServeStats }> {
  const toServer = new PassThrough(), fromServer = new PassThrough(), logs: string[] = [], stats: ServeStats = { peakBuffered: 0, framesIn: 0, maxFrameIn: 0, framesOut: 0 };
  let out = ""; fromServer.on("data", d => { out += d; });
  const done = serveStore({ store, input: toServer, output: fromServer, log: l => logs.push(l), stats });
  for (const part of input) toServer.write(part);
  toServer.end();
  await done; fromServer.end();
  return { replies: out.split("\n").filter(Boolean).map(l => JSON.parse(l)), logs, stats };
}
const hello = JSON.stringify({ type: "req", id: 1, method: "hello", params: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION } }) + "\n";

describe("framing faults (serveStore never crashes, always names the error)", () => {
  it("answers a handshake, rejects other protocols/versions and pre-hello requests", async () => {
    const store = tmpStore();
    try {
      const r = await rawExchange(store, [hello, JSON.stringify({ type: "req", id: 2, method: "hello", params: { protocol: "nope", version: 9 } }) + "\n", JSON.stringify({ type: "req", id: 3, method: "discover", params: {} }) + "\n"]);
      expect(r.replies[0]).toMatchObject({ id: 1, ok: true, result: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, maxFrameBytes: MAX_FRAME_BYTES } });
      expect(r.replies[1]).toMatchObject({ id: 2, ok: false, error: { code: "protocol" } });
      const fresh = await rawExchange(store, [JSON.stringify({ type: "req", id: 3, method: "discover", params: {} }) + "\n"]);
      expect(fresh.replies[0]).toMatchObject({ ok: false, error: { code: "protocol" } });
    } finally { rm(store); }
  });

  it("reports a garbled header as bad-frame and stops, with stdout protocol-only", async () => {
    const store = tmpStore();
    try {
      const r = await rawExchange(store, [hello, "this is not json\n", JSON.stringify({ type: "req", id: 5, method: "discover", params: {} }) + "\n"]);
      expect(r.replies.map(x => x.id ?? null)).toEqual([1, null]);
      expect(r.replies[1]).toMatchObject({ ok: false, error: { code: "bad-frame", retryable: false } });
      expect(r.logs.join()).toContain("bad-frame".length ? "framing" : "");
    } finally { rm(store); }
  });

  it("reports an oversize frame length and an oversize header line by name", async () => {
    const store = tmpStore();
    try {
      const big = await rawExchange(store, [hello, JSON.stringify({ type: "req", id: 2, method: "putBlobChunk", params: { upload: "u1" }, bytes: MAX_FRAME_BYTES + 1 }) + "\n", Buffer.alloc(1024)]);
      expect(big.replies[1]).toMatchObject({ ok: false, error: { code: "frame-too-large" } });
      const line = await rawExchange(store, [hello, Buffer.alloc(MAX_HEADER_BYTES + 1024, 0x61)]);
      expect(line.replies[1]).toMatchObject({ ok: false, error: { code: "frame-too-large" } });
      expect(line.stats.peakBuffered).toBeLessThanOrEqual(MAX_HEADER_BYTES + 64 * 1024);
    } finally { rm(store); }
  });

  it("treats a frame truncated by EOF as a dropped client: no response, no partial blob, no crash", async () => {
    const store = tmpStore();
    try {
      const { binding } = await vault(store), data = randomBytes(100);
      const frames = [hello,
        JSON.stringify({ type: "req", id: 2, method: "open", params: { binding, deviceId: "d" } }) + "\n",
        JSON.stringify({ type: "req", id: 3, method: "putBlobStart", params: { sha256: sha(data), size: 100 } }) + "\n",
        JSON.stringify({ type: "req", id: 4, method: "putBlobChunk", params: { upload: "u1" }, bytes: 100 }) + "\n", Buffer.from(data.subarray(0, 40))];
      const r = await rawExchange(store, frames);
      expect(r.replies.map(x => x.id)).toEqual([1, 2, 3]);
      expect(r.logs.join("\n")).toMatch(/mid-frame/);
      expect(visibleBlobs(store)).toEqual([]);
      expect(await until(() => tmpFiles(join(store, "blobs")).length === 0)).toBe(true);
    } finally { rm(store); }
  });

  it("rejects bad requests without dropping the connection, including chunks past the declared size", async () => {
    const store = tmpStore();
    try {
      const { binding } = await vault(store), data = randomBytes(10);
      const req = (id: number, method: string, params: object, body?: Uint8Array) => [JSON.stringify({ type: "req", id, method, params, ...(body ? { bytes: body.length } : {}) }) + "\n", ...(body ? [Buffer.from(body)] : [])];
      const r = await rawExchange(store, [hello, ...req(2, "scan", {}), ...req(3, "open", { binding, deviceId: "d" }), ...req(4, "nope", {}), ...req(5, "putBlobStart", { sha256: sha(data), size: 10 }),
        ...req(6, "putBlobChunk", { upload: "u1" }, randomBytes(11)), ...req(7, "putBlobCommit", { upload: "u1" }), ...req(8, "putBlobChunk", { upload: "u1" }), ...req(9, "putBlobStart", { sha256: sha(data), size: SYNC_MAX_FILE_BYTES + 1 })]);
      const byId = Object.fromEntries(r.replies.map(x => [x.id, x]));
      expect(byId[2].error.code).toBe("invalid-request");
      expect(byId[3].ok).toBe(true);
      expect(byId[4].error.code).toBe("invalid-request");
      expect(byId[6].error.code).toBe("size-mismatch");
      expect(byId[7].error.code).toBe("not-found");
      expect(byId[8].error.code).toBe("not-found");
      expect(byId[9].error.code).toBe("too-large");
      expect(visibleBlobs(store)).toEqual([]);
    } finally { rm(store); }
  });

  it("detects a hash mismatch at commit over the wire and publishes nothing", async () => {
    const store = tmpStore();
    try {
      const { binding } = await vault(store), a = randomBytes(5000), b = randomBytes(5000);
      const provider = inProcessProvider(store), client = provider.client;
      await provider.open({ binding, deviceId: "d" }, never);
      const { result } = await client.call("putBlobStart", { sha256: sha(a), size: 5000 });
      await client.call("putBlobChunk", { upload: result.upload }, undefined, b);
      await expect(client.call("putBlobCommit", { upload: result.upload })).rejects.toMatchObject({ code: "hash-mismatch" });
      expect(visibleBlobs(store)).toEqual([]);
      expect(tmpFiles(join(store, "blobs"))).toEqual([]);
      await provider.close();
    } finally { rm(store); }
  });
});

describe("crash safety", () => {
  it("a process killed mid-blob leaves no visible blob, and a retry on a fresh process succeeds", async () => {
    const store = tmpStore();
    try {
      const { binding } = await vault(store), data = randomBytes(9 * 1024 * 1024), digest = sha(data);
      const child = await spawnServe(store), client = new RpcClient(() => child.transport);
      await client.call("open", { binding, deviceId: "d" });
      const { result } = await client.call("putBlobStart", { sha256: digest, size: data.length });
      await client.call("putBlobChunk", { upload: result.upload }, undefined, data.subarray(0, 4 * 1024 * 1024));
      child.proc.kill("SIGKILL");
      await child.exited;
      await expect(client.call("putBlobChunk", { upload: result.upload }, undefined, data.subarray(4 * 1024 * 1024, 8 * 1024 * 1024))).rejects.toMatchObject({ code: "unavailable", retryable: true });
      expect(visibleBlobs(store)).toEqual([]);
      expect(tmpFiles(join(store, "blobs")).length).toBe(1); // orphaned temp file: invisible, reaped later
      const fs = new FsStoreProvider(store), session = await fs.open({ binding, deviceId: "d" }, never);
      await expect(session.readBlob({ id: digest, sha256: digest, size: data.length }, never)).rejects.toMatchObject({ code: "not-found" });

      const retry = childProvider(store), rsession = await retry.open({ binding, deviceId: "d" }, never);
      const ref = await rsession.putBlob({ operationId: "o", sha256: digest, size: data.length, data: data.buffer as ArrayBuffer }, never);
      expect(ref.sha256).toBe(digest);
      expect(sha(await session.readBlob(ref, never))).toBe(digest);
      await retry.close();
    } finally { rm(store); }
  }, 60_000);

  it("a record file without an index line is invisible; the identical retry publishes it once, a differing one conflicts", async () => {
    const store = tmpStore();
    try {
      const { binding, session } = await vault(store), r = record(binding.vaultId, "orphan");
      writeFileSync(join(store, "records", "orphan.json"), canonicalJson(r));
      expect((await session.scan(undefined, never)).records).toEqual([]);
      await expect(session.appendRecord({ ...r, deleted: true }, never)).rejects.toMatchObject({ code: "conflict" });
      expect((await session.scan(undefined, never)).records).toEqual([]);
      await session.appendRecord(r, never);
      await session.appendRecord(r, never);
      expect(readFileSync(join(store, "index.log"), "utf8")).toBe("orphan\n");
      expect((await session.scan(undefined, never)).records).toEqual([r]);
    } finally { rm(store); }
  });

  it("ignores a torn index tail on scan and repairs it on the next append", async () => {
    const store = tmpStore();
    try {
      const { binding, session } = await vault(store);
      await session.appendRecord(record(binding.vaultId, "r1"), never);
      await session.appendRecord(record(binding.vaultId, "r2"), never);
      writeFileSync(join(store, "index.log"), "r1\nr2\nr3-torn");
      const scan = await session.scan(undefined, never);
      expect((scan.records as any[]).map(x => x.recordId)).toEqual(["r1", "r2"]);
      expect(scan.cursor).toBe(String("r1\nr2\n".length));
      await session.appendRecord(record(binding.vaultId, "r4"), never);
      expect(readFileSync(join(store, "index.log"), "utf8")).toBe("r1\nr2\nr4\n");
    } finally { rm(store); }
  });
});

describe("single-writer lock", () => {
  it("two processes plus the parent appending concurrently lose and duplicate nothing", async () => {
    const store = tmpStore();
    try {
      const { binding, session } = await vault(store);
      const parent = (async () => { for (let i = 0; i < 40; i++) await session.appendRecord(record(binding.vaultId, `p-${i}`), never); })();
      await Promise.all([runAppender(store, "a", 120), runAppender(store, "b", 120), parent]);
      const lines = readFileSync(join(store, "index.log"), "utf8").split("\n").filter(Boolean);
      expect(lines.length).toBe(280);
      expect(new Set(lines).size).toBe(280);
      expect(readdirSync(join(store, "records")).filter(n => n.endsWith(".json")).length).toBe(280);
      expect(((await session.scan(undefined, never)).records as any[]).length).toBe(280);
      expect(readdirSync(store)).not.toContain(".lock");
    } finally { rm(store); }
  }, 120_000);

  const staleLock = (store: string, owner: object | null, ageSeconds = 0) => {
    const dir = join(store, ".lock"); mkdirSync(dir);
    if (owner) writeFileSync(join(dir, "owner.json"), JSON.stringify(owner));
    if (ageSeconds) { const t = new Date(Date.now() - ageSeconds * 1000); utimesSync(dir, t, t); }
  };

  it("recovers from a lock whose holder pid is dead", async () => {
    const store = tmpStore();
    try {
      const { binding, session } = await vault(store);
      staleLock(store, { pid: 2 ** 22 - 3, bootId: currentBootId(), token: "dead", startedAt: 0 });
      await Promise.race([session.appendRecord(record(binding.vaultId, "r"), never), new Promise((_, no) => setTimeout(() => no(new Error("lock not recovered")), 5000))]);
      expect(readFileSync(join(store, "index.log"), "utf8")).toBe("r\n");
    } finally { rm(store); }
  });

  it("recovers from a lock left by a previous boot even if its pid is now alive", async () => {
    const store = tmpStore();
    try {
      const { binding, session } = await vault(store);
      if (currentBootId() === "unknown") return;
      staleLock(store, { pid: process.pid, bootId: "some-earlier-boot", token: "old", startedAt: 0 });
      await session.appendRecord(record(binding.vaultId, "r"), AbortSignal.timeout(5000));
      expect(readFileSync(join(store, "index.log"), "utf8")).toBe("r\n");
    } finally { rm(store); }
  });

  it("recovers from an ownerless lock directory once it is old, but waits while it is fresh", async () => {
    const store = tmpStore();
    try {
      const { binding, session } = await vault(store);
      staleLock(store, null);
      await expect(session.appendRecord(record(binding.vaultId, "r"), AbortSignal.timeout(300))).rejects.toBeTruthy();
      rm(join(store, ".lock")); staleLock(store, null, 60);
      await session.appendRecord(record(binding.vaultId, "r"), AbortSignal.timeout(5000));
      expect(readFileSync(join(store, "index.log"), "utf8")).toBe("r\n");
    } finally { rm(store); }
  });

  it("never breaks a lock held by a live process and can be cancelled while waiting", async () => {
    const store = tmpStore();
    try {
      const { binding, session } = await vault(store);
      staleLock(store, { pid: process.pid, bootId: currentBootId(), token: "live", startedAt: Date.now() });
      await expect(session.appendRecord(record(binding.vaultId, "r"), AbortSignal.timeout(300))).rejects.toBeTruthy();
      expect(statSync(join(store, ".lock")).isDirectory()).toBe(true);
      await expect(withStoreLock(store, never, async () => 1, 200)).rejects.toMatchObject({ code: "lock-timeout", retryable: true });
    } finally { rm(store); }
  });
});

describe("connection loss and cancellation", () => {
  it("maps a dropped connection to a retryable unavailable status and recovers on reconnect", async () => {
    const store = tmpStore();
    try {
      const { binding } = await vault(store);
      const children: Awaited<ReturnType<typeof spawnServe>>[] = [];
      let reachable = true;
      const provider = new RpcStoreProvider(async () => { if (!reachable) throw new Error("network down"); const child = await spawnServe(store); children.push(child); return child.transport; });
      const session = await provider.open({ binding, deviceId: "d" }, never);
      await session.appendRecord(record(binding.vaultId, "r1"), never);
      children[0].proc.kill("SIGKILL"); await children[0].exited; reachable = false;
      expect((await session.scan(undefined, never)).status).toBe("unavailable");
      await expect(session.appendRecord(record(binding.vaultId, "r2"), never)).rejects.toMatchObject({ code: "unavailable", retryable: true });
      reachable = true;
      // the next call transparently reconnects and re-opens the vault
      await session.appendRecord(record(binding.vaultId, "r2"), never);
      expect(children.length).toBe(2);
      const scan = await session.scan(undefined, never);
      expect(scan.status).toBe("complete");
      expect((scan.records as any[]).map(x => x.recordId)).toEqual(["r1", "r2"]);
      await provider.close();
    } finally { rm(store); }
  }, 30_000);

  it("fails fast with unavailable when the server cannot be spawned", async () => {
    const provider = new RpcStoreProvider(() => { throw new Error("spawn ENOENT"); });
    await expect(provider.discover(never)).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });

  it("aborting mid-transfer cancels the upload and leaves no blob or temp file; a retry succeeds", async () => {
    const store = tmpStore();
    try {
      const { binding } = await vault(store), stats: ServeStats = { peakBuffered: 0, framesIn: 0, maxFrameIn: 0, framesOut: 0 };
      const controller = new AbortController();
      let bigWrites = 0;
      const provider = new RpcStoreProvider(() => {
        const toServer = new PassThrough(), fromServer = new PassThrough(), write = toServer.write.bind(toServer) as (...a: any[]) => boolean;
        // Abort exactly as the 4th 4 MiB data frame goes out: requests are lock-step, so this is deterministic.
        (toServer as any).write = (chunk: Buffer, ...rest: any[]) => { if (chunk.length >= 1 << 20 && ++bigWrites === 4) queueMicrotask(() => controller.abort()); return write(chunk, ...rest); };
        void serveStore({ store, input: toServer, output: fromServer, stats }).finally(() => fromServer.end());
        return { input: fromServer, output: toServer, close: () => { toServer.end(); } };
      });
      const session = await provider.open({ binding, deviceId: "d" }, never);
      const data = randomBytes(60 * 1024 * 1024), digest = sha(data);
      await expect(session.putBlob({ operationId: "o", sha256: digest, size: data.length, data: data.buffer as ArrayBuffer }, controller.signal)).rejects.toBeTruthy();
      expect(await until(() => tmpFiles(join(store, "blobs")).length === 0)).toBe(true);
      expect(visibleBlobs(store)).toEqual([]);
      expect(stats.framesIn).toBeLessThanOrEqual(2 + 1 + 4 + 2); // hello, open, start, <=4 chunks, abort + putBlobAbort; never the other 11 chunks
      bigWrites = -1000; // let the retry through
      const ref = await session.putBlob({ operationId: "o2", sha256: digest, size: data.length, data: data.buffer as ArrayBuffer }, never);
      expect(ref.id).toBe(digest);
      expect(statSync(join(store, "blobs", digest)).size).toBe(data.length);
      await provider.close();
    } finally { rm(store); }
  }, 60_000);
});

describe("bounded memory on large blobs", () => {
  const SIZE = 99 * 1024 * 1024, CHUNKS = Math.ceil(SIZE / (4 * 1024 * 1024));

  it("moves a 99 MiB blob in 4 MiB binary frames (in-process pipes)", async () => {
    const store = tmpStore();
    try {
      const { binding } = await vault(store), stats: ServeStats = { peakBuffered: 0, framesIn: 0, maxFrameIn: 0, framesOut: 0 };
      const provider = inProcessProvider(store, stats), session = await provider.open({ binding, deviceId: "d" }, never);
      const data = randomBytes(SIZE), digest = sha(data);
      const ref = await session.putBlob({ operationId: "o", sha256: digest, size: SIZE, data: data.buffer as ArrayBuffer }, never);
      expect(ref).toEqual({ id: digest, sha256: digest, size: SIZE });
      // hello + open + start + CHUNKS chunks + commit
      expect(stats.framesIn).toBe(4 + CHUNKS);
      expect(stats.maxFrameIn).toBe(4 * 1024 * 1024);
      expect(stats.peakBuffered).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(statSync(join(store, "blobs", digest)).size).toBe(SIZE);
      expect(sha(await session.readBlob(ref, never))).toBe(digest);
      await provider.close();
    } finally { rm(store); }
  }, 120_000);

  it("server process memory does not grow with blob size (child process)", async () => {
    const run = async (mb: number) => {
      const store = tmpStore();
      try {
        const { binding } = await vault(store), children: Awaited<ReturnType<typeof spawnServe>>[] = [];
        const provider = childProvider(store, children), session = await provider.open({ binding, deviceId: "d" }, never);
        const data = randomBytes(mb * 1024 * 1024), digest = sha(data);
        const ref = await session.putBlob({ operationId: "o", sha256: digest, size: data.length, data: data.buffer as ArrayBuffer }, never);
        expect(sha(await session.readBlob(ref, never))).toBe(digest);
        await provider.close(); await children[0].exited;
        return JSON.parse(/STATS (.*)/.exec(children[0].stderr())![1]) as ServeStats & { maxRssKb: number };
      } finally { rm(store); }
    };
    const small = await run(1), mid = await run(40), big = await run(99);
    for (const s of [mid, big]) { expect(s.maxFrameIn).toBe(4 * 1024 * 1024); expect(s.peakBuffered).toBeLessThanOrEqual(4 * 1024 * 1024); }
    const mib = (kb: number) => kb / 1024;
    console.log(`child maxRSS MiB: 1MiB blob=${mib(small.maxRssKb).toFixed(0)}, 40MiB=${mib(mid.maxRssKb).toFixed(0)}, 99MiB=${mib(big.maxRssKb).toFixed(0)}`);
    // A buffering server grows linearly (+59 MiB from 40 to 99 MiB, on top of copies); a chunked one plateaus.
    expect(mib(big.maxRssKb) - mib(mid.maxRssKb)).toBeLessThan(20);
    expect(mib(big.maxRssKb) - mib(small.maxRssKb)).toBeLessThan(70);
  }, 120_000);
});
