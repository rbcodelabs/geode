import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
