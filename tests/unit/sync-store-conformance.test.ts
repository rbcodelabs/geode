import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FsStoreProvider } from "../../src/sync-node/index";
import { SYNC_MAX_FILE_BYTES, type AppendOnlySyncProvider, type VaultDescriptor } from "../../src/sync-core/history-types";
import { bytes, childProvider, cleanBundle, inProcessProvider, never, randomBytes, record, rm, sha, tmpStore, type Child } from "../helpers/sync-store-harness";

interface Fixture { provider: AppendOnlySyncProvider; store: string; cleanup(): Promise<void> }
const variants: Array<[string, () => Promise<Fixture>]> = [
  ["FsStoreProvider (direct)", async () => { const store = tmpStore(); return { provider: new FsStoreProvider(store), store, cleanup: async () => rm(store) }; }],
  ["RpcStoreProvider <-> serveStore (in-process pipes)", async () => { const store = tmpStore(), provider = inProcessProvider(store); return { provider, store, cleanup: async () => { await provider.close(); rm(store); } }; }],
  ["RpcStoreProvider <-> serveStore (child process)", async () => {
    const store = tmpStore(), children: Child[] = [], provider = childProvider(store, children);
    return { provider, store, cleanup: async () => { await provider.close(); await Promise.all(children.map(c => c.exited)); rm(store); } };
  }],
];

afterAll(() => cleanBundle());
beforeAll(() => { /* bundle lazily on first child spawn */ });

for (const [name, make] of variants) describe(`AppendOnlySession conformance: ${name}`, () => {
  let fx: Fixture, binding: VaultDescriptor;
  const open = (deviceId = "dev") => fx.provider.open({ binding, deviceId }, never);
  const setup = async () => { fx = await make(); binding = await fx.provider.createVault({ name: "hub", operationId: "op-1" }, never); };
  const teardown = async () => fx.cleanup();

  it("discovers nothing in an empty store, then the created vault; createVault retries are idempotent", async () => {
    fx = await make();
    try {
      expect(await fx.provider.discover(never)).toEqual([]);
      const created = await fx.provider.createVault({ name: "hub", operationId: "op-1" }, never);
      expect(created).toMatchObject({ schema: 1, protocol: "append-only-history-v1", name: "hub" });
      expect(await fx.provider.discover(never)).toEqual([created]);
      expect(await fx.provider.createVault({ name: "hub", operationId: "op-1" }, never)).toEqual(created);
      await expect(fx.provider.createVault({ name: "hub", operationId: "op-2" }, never)).rejects.toMatchObject({ code: "conflict" });
      expect(JSON.parse(readFileSync(join(fx.store, "descriptor.json"), "utf8"))).toEqual(created);
    } finally { await teardown(); }
  });

  it("refuses to open a binding that is not the store's vault", async () => {
    await setup();
    try {
      await expect(fx.provider.open({ binding: { ...binding, vaultId: "other" }, deviceId: "d" }, never)).rejects.toMatchObject({ code: "not-found" });
    } finally { await teardown(); }
  });

  describe("session", () => {
    it("round-trips blobs (empty, small, multi-chunk), idempotently, content-addressed", async () => {
      await setup();
      try {
        const s = await open();
        for (const data of [new Uint8Array(0), new TextEncoder().encode("hello"), randomBytes(9 * 1024 * 1024 + 17)]) {
          const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, digest = sha(ab);
          const ref = await s.putBlob({ operationId: "op", sha256: digest, size: ab.byteLength, data: ab }, never);
          expect(ref).toEqual({ id: digest, sha256: digest, size: ab.byteLength });
          expect(await s.putBlob({ operationId: "again", sha256: digest, size: ab.byteLength, data: ab }, never)).toEqual(ref);
          expect(sha(await s.readBlob(ref, never))).toBe(digest);
          expect(readdirSync(join(fx.store, "blobs")).filter(n => !n.startsWith(".tmp-")).includes(digest)).toBe(true);
        }
        await s.close();
      } finally { await teardown(); }
    });

    it("rejects a hash or size mismatch with a named error and leaves nothing behind", async () => {
      await setup();
      try {
        const s = await open(), data = bytes("payload"), wrong = sha(bytes("different"));
        await expect(s.putBlob({ operationId: "o", sha256: wrong, size: data.byteLength, data }, never)).rejects.toMatchObject({ code: "hash-mismatch" });
        await expect(s.putBlob({ operationId: "o", sha256: sha(data), size: data.byteLength + 1, data }, never)).rejects.toMatchObject({ code: "size-mismatch" });
        await expect(s.readBlob({ id: wrong, sha256: wrong, size: data.byteLength }, never)).rejects.toMatchObject({ code: "not-found" });
        await expect(s.readBlob({ id: sha(data), sha256: sha(data), size: data.byteLength }, never)).rejects.toMatchObject({ code: "not-found" });
        expect(readdirSync(join(fx.store, "blobs")).filter(n => !n.startsWith(".tmp-"))).toEqual([]);
      } finally { await teardown(); }
    });

    it("enforces the 100 MiB file limit", async () => {
      await setup();
      try {
        const s = await open(), data = new ArrayBuffer(SYNC_MAX_FILE_BYTES + 1);
        await expect(s.putBlob({ operationId: "o", sha256: "0".repeat(64), size: data.byteLength, data }, never)).rejects.toMatchObject({ code: "too-large" });
        await expect(s.readBlob({ id: "0".repeat(64), sha256: "0".repeat(64), size: SYNC_MAX_FILE_BYTES + 1 }, never)).rejects.toMatchObject({ code: "too-large" });
      } finally { await teardown(); }
    });

    it("appends records, scans them in order with an incremental cursor", async () => {
      await setup();
      try {
        const s = await open(), data = bytes("blob"), ref = await s.putBlob({ operationId: "o", sha256: sha(data), size: data.byteLength, data }, never);
        const first = await s.scan(undefined, never);
        expect(first).toMatchObject({ status: "complete", records: [] });
        await s.appendRecord(record(binding.vaultId, "r1", ref), never);
        await s.appendRecord(record(binding.vaultId, "r2"), never);
        const all = await s.scan(undefined, never);
        expect(all.status).toBe("complete");
        expect((all.records as any[]).map(r => r.recordId)).toEqual(["r1", "r2"]);
        expect((all.records as any[])[0].blob).toEqual(ref);
        await s.appendRecord(record(binding.vaultId, "r3"), never);
        const delta = await s.scan(all.cursor, never);
        expect((delta.records as any[]).map(r => r.recordId)).toEqual(["r3"]);
        expect((await s.scan(delta.cursor, never)).records).toEqual([]);
        expect(readFileSync(join(fx.store, "index.log"), "utf8")).toBe("r1\nr2\nr3\n");
      } finally { await teardown(); }
    });

    it("treats an identical retry as success and a differing payload under one id as a conflict", async () => {
      await setup();
      try {
        const s = await open(), r = record(binding.vaultId, "dup");
        await s.appendRecord(r, never);
        await s.appendRecord({ ...r }, never);
        await expect(s.appendRecord({ ...r, deleted: true }, never)).rejects.toMatchObject({ code: "conflict" });
        const scan = await s.scan(undefined, never);
        expect(scan.records).toEqual([r]);
        expect(readFileSync(join(fx.store, "index.log"), "utf8")).toBe("dup\n");
      } finally { await teardown(); }
    });

    it("validates records: missing blob, bad id, foreign vault", async () => {
      await setup();
      try {
        const s = await open(), ghost = { id: "a".repeat(64), sha256: "a".repeat(64), size: 3 };
        await expect(s.appendRecord(record(binding.vaultId, "x1", ghost), never)).rejects.toMatchObject({ code: "invalid-record" });
        await expect(s.appendRecord(record(binding.vaultId, "../escape"), never)).rejects.toMatchObject({ code: "invalid-record" });
        await expect(s.appendRecord(record("not-this-vault", "x2"), never)).rejects.toMatchObject({ code: "invalid-record" });
        expect((await s.scan(undefined, never)).records).toEqual([]);
      } finally { await teardown(); }
    });

    it("signals reset for a cursor beyond the log and still returns everything", async () => {
      await setup();
      try {
        const s = await open();
        await s.appendRecord(record(binding.vaultId, "r1"), never);
        const scan = await s.scan("99999", never);
        expect(scan.reset).toBe(true);
        expect((scan.records as any[]).map(r => r.recordId)).toEqual(["r1"]);
      } finally { await teardown(); }
    });

    it("pages large histories without loss or reordering", async () => {
      await setup();
      try {
        const s = await open(), ids = Array.from({ length: 650 }, (_, i) => `r${String(i).padStart(4, "0")}`);
        for (const id of ids) await s.appendRecord(record(binding.vaultId, id), never);
        const scan = await s.scan(undefined, never);
        expect(scan.status).toBe("complete");
        expect((scan.records as any[]).map(r => r.recordId)).toEqual(ids);
      } finally { await teardown(); }
    }, 60_000);

    it("honours pre-aborted signals", async () => {
      await setup();
      try {
        const s = await open(), aborted = AbortSignal.abort(), data = bytes("x");
        await expect(s.putBlob({ operationId: "o", sha256: sha(data), size: 1, data }, aborted)).rejects.toBeTruthy();
        await expect(s.appendRecord(record(binding.vaultId, "r"), aborted)).rejects.toBeTruthy();
        expect((await s.scan(undefined, aborted)).status).toBe("cancelled");
        expect((await s.scan(undefined, never)).records).toEqual([]);
      } finally { await teardown(); }
    });
  });
});
