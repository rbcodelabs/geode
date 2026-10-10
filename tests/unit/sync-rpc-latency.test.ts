import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { latencyProvider } from "../helpers/latency-transport";
import { device, never, put, rmrf, tmp } from "../helpers/node-host-harness";
import { bytes, record, sha } from "../helpers/sync-store-harness";
import { FsStoreProvider, serveStore } from "../../src/sync-node/index";
import type { AppendOnlySyncProvider, VaultDescriptor } from "../../src/sync-core/history-types";

const N = Number(process.env.GEODE_BENCH_FILES ?? 40), ONE_WAY = Number(process.env.GEODE_BENCH_ONEWAY_MS ?? 35);

async function world(files: number) {
  const store = tmp("lat-store"), root = tmp("lat-root"), state = tmp("lat-state");
  const binding = await new FsStoreProvider(store).createVault({ name: "b", operationId: "lat" }, never);
  for (let i = 0; i < files; i++) put(root, `d${i % 7}/note-${i}.md`, `# note ${i}\n${"x".repeat(200 + i)}`);
  return { store, root, state, binding, done: () => { rmrf(store); rmrf(root); rmrf(state); } };
}
const indexIds = (store: string) => existsSync(join(store, "index.log")) ? readFileSync(join(store, "index.log"), "utf8").split("\n").filter(Boolean) : [];
/** The ordering invariant of the store: whatever scan() can see is complete, and every blob it names is present. */
function assertStoreConsistent(store: string) {
  for (const id of indexIds(store)) {
    const rec = JSON.parse(readFileSync(join(store, "records", `${id}.json`), "utf8"));
    if (rec.blob) expect(existsSync(join(store, "blobs", rec.blob.sha256)), `blob of ${id}`).toBe(true);
  }
  expect(readdirSync(join(store, "blobs")).filter(n => n.startsWith(".tmp-"))).toEqual([]);
}
const fileCount = (store: string) => indexIds(store).map(id => JSON.parse(readFileSync(join(store, "records", `${id}.json`), "utf8"))).filter(r => r.kind === "file" && !r.deleted).length;

describe("first upload over a high-latency link", () => {
  it("costs about one pipelined request per file, with no read-back, and publishes everything", async () => {
    const w = await world(60);
    try {
      const link = latencyProvider(w.store, 5);
      await device("a", w.root, join(w.state, "s"), link.provider, w.binding).sync(true);
      expect(fileCount(w.store)).toBe(60);
      expect(link.counts.readBlobRange ?? 0).toBe(0);
      expect(link.counts.putBlob).toBe(60);
      expect(link.counts.putBlobStart ?? 0).toBe(0);
      expect(link.counts.appendRecord ?? 0).toBe(0);
      expect(link.counts.appendRecords).toBeLessThanOrEqual(20); // records are batched, not one round trip each
      assertStoreConsistent(w.store);
      await link.provider.close();
    } finally { w.done(); }
  }, 60_000);

  it("an old server (no optional methods) still works: three-step uploads and one append per record", async () => {
    const w = await world(30);
    try {
      const link = latencyProvider(w.store, 2, { serve: o => serveStore({ ...o, legacy: true }) });
      await device("a", w.root, join(w.state, "s"), link.provider, w.binding).sync(true);
      expect(fileCount(w.store)).toBe(30);
      expect(link.counts.putBlob ?? 0).toBe(0);
      expect(link.counts.appendRecords ?? 0).toBe(0);
      expect(link.counts.putBlobStart).toBe(30);
      expect(link.counts.readBlobRange ?? 0).toBe(0); // the receipt is hash-verified by the server, so the read-back is gone for old servers too
      assertStoreConsistent(w.store);
      await link.provider.close();
    } finally { w.done(); }
  }, 60_000);

  it("a failed upload stops the batch: records stay a consistent prefix, and a retry converges without duplicates", async () => {
    const w = await world(40);
    try {
      const link = latencyProvider(w.store, 1);
      let calls = 0, armed = true;
      const faulty: AppendOnlySyncProvider = Object.create(link.provider, {
        open: { value: async (ctx: { binding: VaultDescriptor; deviceId: string }, signal: AbortSignal) => {
          const session = await link.provider.open(ctx, signal);
          return Object.create(session, { putBlob: { value: (input: any, s: AbortSignal) => { if (armed && ++calls === 17) return Promise.reject(new Error("injected upload failure")); return session.putBlob(input, s); } } });
        } },
      });
      const dev = device("a", w.root, join(w.state, "s"), faulty, w.binding);
      await expect(dev.sync(true)).rejects.toThrow(/injected upload failure/);
      const partial = indexIds(w.store).length;
      expect(partial).toBeLessThan(40); // the failing operation and everything after it were never appended
      assertStoreConsistent(w.store);
      armed = false;
      await dev.sync(true);
      expect(fileCount(w.store)).toBe(40);
      const ids = indexIds(w.store);
      expect(new Set(ids).size).toBe(ids.length);
      assertStoreConsistent(w.store);
      await link.provider.close();
    } finally { w.done(); }
  }, 60_000);
});

/** Wraps a provider so every session reads through `readBlob`, with `readConcurrency` forced (undefined = the original one-at-a-time engine path, which also pins each blob to one chunk request at a time only for small blobs). */
function reading(base: AppendOnlySyncProvider, opts: { readConcurrency?: number | undefined; onRead?: (ref: any, n: number) => Promise<void> | void } = {}): AppendOnlySyncProvider & { peak: () => number; peakBytes: () => number; reads: () => number } {
  let active = 0, activeBytes = 0, peak = 0, peakBytes = 0, calls = 0;
  const wrapper: any = Object.create(base, {
    open: { value: async (ctx: { binding: VaultDescriptor; deviceId: string }, signal: AbortSignal) => {
      const session = await base.open(ctx, signal);
      return Object.create(session, {
        readConcurrency: { value: opts.readConcurrency },
        readBlob: { value: async (ref: any, s: AbortSignal) => {
          const n = ++calls; active++; activeBytes += ref.size; peak = Math.max(peak, active); peakBytes = Math.max(peakBytes, activeBytes);
          try { await opts.onRead?.(ref, n); return await session.readBlob(ref, s); } finally { active--; activeBytes -= ref.size; }
        } },
      });
    } },
  });
  wrapper.peak = () => peak; wrapper.peakBytes = () => peakBytes; wrapper.reads = () => calls;
  return wrapper;
}
const treeOf = (root: string) => {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => { for (const e of readdirSync(join(dir), { withFileTypes: true })) { if (e.name.startsWith(".")) continue; const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(join(dir, e.name), r); else out[r] = sha(readFileSync(join(dir, e.name))); } };
  walk(root, ""); return out;
};

describe("first download over a high-latency link", () => {
  async function seeded(files: number) {
    const w = await world(files);
    await device("seed", w.root, join(w.state, "seed"), new FsStoreProvider(w.store), w.binding).sync(true);
    const root2 = tmp("lat-root2"), state2 = tmp("lat-state2");
    return { ...w, root2, state2, done: () => { w.done(); rmrf(root2); rmrf(state2); } };
  }

  it("overlaps blob reads (one request per small file), applies everything identically, and the engine path stays ordered", async () => {
    const w = await seeded(60);
    try {
      const link = latencyProvider(w.store, 3), reader = reading(link.provider, { readConcurrency: 12 });
      await device("b", w.root2, join(w.state2, "s"), reader, w.binding).sync(true);
      expect(treeOf(w.root2)).toEqual(treeOf(w.root));
      expect(reader.reads()).toBe(60);
      expect(reader.peak()).toBeGreaterThan(1);
      expect(reader.peak()).toBeLessThanOrEqual(12);
      expect(link.counts.readBlobRange).toBe(60);
      await link.provider.close();
    } finally { w.done(); }
  }, 60_000);

  it("a session without readConcurrency downloads one at a time exactly as before", async () => {
    const w = await seeded(20);
    try {
      const link = latencyProvider(w.store, 1), reader = reading(link.provider, { readConcurrency: undefined });
      await device("b", w.root2, join(w.state2, "s"), reader, w.binding).sync(true);
      expect(treeOf(w.root2)).toEqual(treeOf(w.root));
      expect(reader.peak()).toBe(1);
      await link.provider.close();
    } finally { w.done(); }
  }, 60_000);

  it("against an old server the pipelined reads still work (reads need no server feature)", async () => {
    const w = await seeded(30);
    try {
      const link = latencyProvider(w.store, 1, { serve: o => serveStore({ ...o, legacy: true }) }), reader = reading(link.provider, { readConcurrency: 12 });
      await device("b", w.root2, join(w.state2, "s"), reader, w.binding).sync(true);
      expect(treeOf(w.root2)).toEqual(treeOf(w.root));
      expect(reader.peak()).toBeGreaterThan(1);
      await link.provider.close();
    } finally { w.done(); }
  }, 60_000);

  it("a blob larger than one chunk is fetched as pipelined ranges and verified", async () => {
    const w = await world(0);
    try {
      const big = Buffer.alloc(9 * 1024 * 1024 + 123); for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 12)) & 255;
      writeFileSync(join(w.root, "big.bin"), big); put(w.root, "small.md", "tiny");
      await device("seed", w.root, join(w.state, "seed"), new FsStoreProvider(w.store), w.binding).sync(true);
      const root2 = tmp("lat-root2"), state2 = tmp("lat-state2");
      try {
        const link = latencyProvider(w.store, 2);
        await device("b", root2, join(state2, "s"), reading(link.provider, { readConcurrency: 12 }), w.binding).sync(true);
        expect(sha(readFileSync(join(root2, "big.bin")))).toBe(sha(big));
        expect(link.counts.readBlobRange).toBe(3 + 1); // 4 MiB ranges + the small file
        await link.provider.close();
      } finally { rmrf(root2); rmrf(state2); }
    } finally { w.done(); }
  }, 60_000);

  it("fetched-ahead bytes stay within the budget (the next blob always runs)", async () => {
    const w = await world(0);
    try {
      for (let i = 0; i < 6; i++) { const b = Buffer.alloc(14 * 1024 * 1024, i + 1); b[0] = i; writeFileSync(join(w.root, `blob-${i}.bin`), b); }
      await device("seed", w.root, join(w.state, "seed"), new FsStoreProvider(w.store), w.binding).sync(true);
      const root2 = tmp("lat-root2"), state2 = tmp("lat-state2");
      try {
        const link = latencyProvider(w.store, 0), reader = reading(link.provider, { readConcurrency: 12 });
        await device("b", root2, join(state2, "s"), reader, w.binding).sync(true);
        expect(treeOf(root2)).toEqual(treeOf(w.root));
        expect(reader.peakBytes()).toBeLessThanOrEqual(64 * 1024 * 1024);
        expect(reader.peak()).toBeGreaterThan(1);
        await link.provider.close();
      } finally { rmrf(root2); rmrf(state2); }
    } finally { w.done(); }
  }, 60_000);

  it("a read that fails mid-batch stops cleanly: earlier files are staged, nothing half-applied, and a retry converges", async () => {
    const w = await seeded(40);
    try {
      const link = latencyProvider(w.store, 1);
      let armed = true;
      const reader = reading(link.provider, { readConcurrency: 12, onRead: (_ref, n) => { if (armed && n === 23) throw new Error("injected read failure"); } });
      const dev = device("b", w.root2, join(w.state2, "s"), reader, w.binding);
      await expect(dev.sync(true)).rejects.toThrow(/injected read failure/);
      expect(Object.keys(treeOf(w.root2)).length).toBe(0); // apply only starts once the whole batch is staged
      armed = false;
      await dev.sync(true);
      expect(treeOf(w.root2)).toEqual(treeOf(w.root));
      await link.provider.close();
    } finally { w.done(); }
  }, 60_000);

  it("a connection drop while reads are in flight surfaces as an error and a fresh sync resumes to completion", async () => {
    const w = await seeded(40);
    try {
      const link = latencyProvider(w.store, 1);
      let armed = true;
      const reader = reading(link.provider, { readConcurrency: 12, onRead: async (_ref, n) => { if (armed && n === 15) { await new Promise(r => setTimeout(r, 20)); throw Object.assign(new Error("link dropped"), { code: "unavailable" }); } } });
      const dev = device("b", w.root2, join(w.state2, "s"), reader, w.binding);
      await expect(dev.sync(true)).rejects.toThrow(/link dropped/);
      armed = false;
      await dev.sync(true);
      expect(treeOf(w.root2)).toEqual(treeOf(w.root));
      const again = await dev.sync(true); // idempotent once converged
      expect(treeOf(w.root2)).toEqual(treeOf(w.root));
      void again;
      await link.provider.close();
    } finally { w.done(); }
  }, 60_000);
});

describe("store protocol additions", () => {
  async function session(legacy = false) {
    const store = tmp("lat-proto"), link = latencyProvider(store, 0, legacy ? { serve: o => serveStore({ ...o, legacy: true }) } : {});
    const binding = await link.provider.createVault({ name: "v", operationId: "proto" }, never);
    return { store, link, binding, session: await link.provider.open({ binding, deviceId: "d" }, never) };
  }

  it("putBlob: one request publishes a verified blob; empty blobs work; bad content is refused and leaves nothing behind", async () => {
    const t = await session();
    try {
      const data = bytes("hello pipelined world");
      const ref = await t.session.putBlob({ operationId: "o", sha256: sha(data), size: data.byteLength, data }, never);
      expect(ref).toMatchObject({ id: sha(data), size: data.byteLength });
      expect(t.link.counts.putBlob).toBe(1);
      const empty = new ArrayBuffer(0);
      expect((await t.session.putBlob({ operationId: "o2", sha256: sha(empty), size: 0, data: empty }, never)).size).toBe(0);
      await expect(t.session.putBlob({ operationId: "o3", sha256: sha(bytes("other")), size: data.byteLength, data }, never)).rejects.toMatchObject({ code: "hash-mismatch" });
      expect(readdirSync(join(t.store, "blobs")).filter(n => n.startsWith(".tmp-"))).toEqual([]);
      expect(await t.session.readBlob(ref, never)).toEqual(data);
    } finally { await t.link.provider.close(); rmrf(t.store); }
  });

  it("appendRecords: appends in order, stops at the first failure, and a retry of the same batch is idempotent", async () => {
    const t = await session();
    try {
      const data = bytes("blob"), ref = await t.session.putBlob({ operationId: "o", sha256: sha(data), size: data.byteLength, data }, never);
      const v = t.binding.vaultId, good1 = record(v, "r1", ref), good2 = record(v, "r2", ref), bad = record(v, "r3", { id: sha(bytes("missing")), sha256: sha(bytes("missing")), size: 7 }), after = record(v, "r4", ref);
      const first = await t.session.appendRecords!([good1, good2, bad, after], never);
      expect(first.appended).toBe(2);
      expect(first.error).toMatchObject({ code: "invalid-record" });
      expect(indexIds(t.store)).toEqual(["r1", "r2"]); // r4 was never attempted, r3 never visible
      const again = await t.session.appendRecords!([good1, good2, after], never);
      expect(again).toEqual({ appended: 3 });
      expect(indexIds(t.store)).toEqual(["r1", "r2", "r4"]); // no duplicate lines for r1/r2
      const conflict = await t.session.appendRecords!([record(v, "r1", ref, { kind: "folder" })], never);
      expect(conflict.appended).toBe(0);
      expect(conflict.error).toMatchObject({ code: "conflict" });
      expect((await t.session.scan(undefined, never)).records).toHaveLength(3);
    } finally { await t.link.provider.close(); rmrf(t.store); }
  });

  it("against an old server the same session API falls back: no optional methods are sent, concurrency is 4", async () => {
    const t = await session(true);
    try {
      expect(t.session.uploadConcurrency).toBe(4);
      const data = bytes("legacy"), ref = await t.session.putBlob({ operationId: "o", sha256: sha(data), size: data.byteLength, data }, never);
      const out = await t.session.appendRecords!([record(t.binding.vaultId, "a", ref), record(t.binding.vaultId, "b", ref)], never);
      expect(out).toEqual({ appended: 2 });
      expect(t.link.counts.putBlob ?? 0).toBe(0);
      expect(t.link.counts.appendRecords ?? 0).toBe(0);
      expect(t.link.counts.appendRecord).toBe(2);
    } finally { await t.link.provider.close(); rmrf(t.store); }
  });

  it("a new server advertises 16 uploads and pipelined putBlobs from one client all land", async () => {
    const t = await session();
    try {
      expect(t.session.uploadConcurrency).toBe(16);
      const items = Array.from({ length: 24 }, (_, i) => bytes(`blob ${i} `.repeat(50)));
      const refs = await Promise.all(items.map(data => t.session.putBlob({ operationId: "o", sha256: sha(data), size: data.byteLength, data }, never)));
      expect(refs.map(r => r.id)).toEqual(items.map(sha));
      assertStoreConsistent(t.store);
    } finally { await t.link.provider.close(); rmrf(t.store); }
  });
});

describe.skipIf(!process.env.GEODE_SYNC_BENCH)("bench: first upload of small files under simulated latency", () => {
  it("reports files/sec and requests per file", async () => {
    const w = await world(N);
    try {
      const link = latencyProvider(w.store, ONE_WAY);
      const dev = device("bench", w.root, join(w.state, "s"), link.provider, w.binding);
      const t0 = Date.now(); await dev.sync(true); const secs = (Date.now() - t0) / 1000;
      console.log(`BENCH rtt=${ONE_WAY * 2}ms files=${N} seconds=${secs.toFixed(2)} files/sec=${(N / secs).toFixed(2)} requests=${link.requests()} perFile=${(link.requests() / N).toFixed(2)} ${JSON.stringify(link.counts)}`);
      await link.provider.close();
    } finally { w.done(); }
  }, 600_000);
});

describe.skipIf(!process.env.GEODE_SYNC_BENCH)("bench: first download under simulated latency", () => {
  const FILES = Number(process.env.GEODE_BENCH_DL_FILES ?? 120), KB = Number(process.env.GEODE_BENCH_DL_KB ?? 64);
  for (const [label, concurrency] of [["before (sequential reads)", undefined], ["after (pipelined reads)", 12]] as const) {
    it(label, async () => {
      const w = await world(0);
      const root2 = tmp("lat-root2"), state2 = tmp("lat-state2");
      try {
        let total = 0;
        for (let i = 0; i < FILES; i++) { const b = Buffer.alloc(KB * 1024, i % 251); b.writeUInt32LE(i, 0); total += b.length; writeFileSync(join(w.root, `f${i}.bin`), b); }
        await device("seed", w.root, join(w.state, "seed"), new FsStoreProvider(w.store), w.binding).sync(true);
        const link = latencyProvider(w.store, ONE_WAY), reader = reading(link.provider, { readConcurrency: concurrency });
        const t0 = Date.now(); await device("b", root2, join(state2, "s"), reader, w.binding).sync(true); const secs = (Date.now() - t0) / 1000;
        console.log(`BENCH-DL ${label} rtt=${ONE_WAY * 2}ms files=${FILES} sizeKB=${KB} seconds=${secs.toFixed(2)} files/sec=${(FILES / secs).toFixed(2)} MB/s=${(total / 1048576 / secs).toFixed(2)} peakInflight=${reader.peak()} ${JSON.stringify(link.counts)}`);
        await link.provider.close();
      } finally { w.done(); rmrf(root2); rmrf(state2); }
    }, 900_000);
  }
});
