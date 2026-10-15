import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { AT_REST_CHUNK_BYTES, AT_REST_MIN_BYTES, FsStoreProvider, FsStoreSession, sweepOrphanChunks } from "../../src/sync-node/index";
import type { BlobRef, VaultDescriptor } from "../../src/sync-core/history-types";
import { inProcessProvider, never, randomBytes, record, rm, sha, tmpStore } from "../helpers/sync-store-harness";

const MIB = 1024 * 1024;
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const dirs: string[] = [];
const files = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(n => !n.startsWith(".tmp-")) : [];
const chunkFiles = (store: string) => files(join(store, "chunks")).flatMap(d => files(join(store, "chunks", d)).map(n => join(store, "chunks", d, n)));
const chunkBytes = (store: string) => chunkFiles(store).reduce((n, p) => n + statSync(p).size, 0);

let store: string, binding: VaultDescriptor, session: FsStoreSession;
beforeEach(async () => {
  store = tmpStore(); dirs.push(store);
  const provider = new FsStoreProvider(store);
  binding = await provider.createVault({ name: "hub", operationId: "op-1" }, never);
  session = await provider.open({ binding, deviceId: "dev" }, never) as FsStoreSession;
});
afterEach(() => { delete process.env.GEODE_HUB_CHUNKED; });
afterAll(() => { for (const d of dirs) rm(d); });

const put = (data: Uint8Array) => session.putBlob({ operationId: randomUUID(), sha256: sha(data), size: data.length, data: buf(data) }, never);
const equal = async (ref: BlobRef, data: Uint8Array) => expect(Buffer.from(await session.readBlob(ref, never)).equals(Buffer.from(data))).toBe(true);

describe("chunked blobs at rest", () => {
  it("stores a large blob as chunks + manifest and reads it back whole, by range, and by size", async () => {
    const data = randomBytes(5 * MIB + 1234), ref = await put(data);
    expect(ref).toEqual({ id: sha(data), sha256: sha(data), size: data.length });
    expect(existsSync(join(store, "blobs", ref.id))).toBe(false);
    expect(existsSync(join(store, "blobs", `${ref.id}.manifest`))).toBe(true);
    expect(chunkFiles(store)).toHaveLength(6); expect(chunkBytes(store)).toBe(data.length);
    await equal(ref, data);
    expect(await session.blobSize(ref.id)).toBe(data.length);
    // a range spanning three chunks, one starting mid-chunk, and one ending at EOF
    for (const [offset, length] of [[MIB - 10, 2 * MIB + 20], [3 * MIB + 5, 100], [data.length - 50, 50]] as const) {
      expect(Buffer.from(await session.readBlobRange(ref.id, offset, length, never)).equals(Buffer.from(data.subarray(offset, offset + length)))).toBe(true);
    }
    expect((await session.readBlobRange(ref.id, data.length, 10, never)).length).toBe(0);
    await expect(session.readBlobRange(ref.id, data.length + 1, 10, never)).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("keeps small blobs as whole files", async () => {
    const data = randomBytes(AT_REST_MIN_BYTES - 1), ref = await put(data);
    expect(statSync(join(store, "blobs", ref.id)).size).toBe(data.length);
    expect(chunkFiles(store)).toHaveLength(0); await equal(ref, data);
  });

  it("an appended file costs only its new tail per version", async () => {
    const v1 = randomBytes(6 * MIB), v2 = concat(v1, randomBytes(100_000)), v3 = concat(v2, randomBytes(100_000));
    const refs = [await put(v1), await put(v2), await put(v3)];
    expect(chunkFiles(store)).toHaveLength(6 + 2); // 6 shared full chunks + the v2 tail + the v3 tail
    expect(chunkBytes(store)).toBe(6 * MIB + 100_000 + 200_000);
    // the same three versions as whole files would be 18.6 MB; chunked they are 6.3 MB
    expect(chunkBytes(store)).toBeLessThan((v1.length + v2.length + v3.length) / 2.5);
    await equal(refs[0], v1); await equal(refs[1], v2); await equal(refs[2], v3);
  });

  it("re-putting the same blob stores nothing new", async () => {
    const data = randomBytes(4 * MIB), a = await put(data), before = chunkBytes(store), manifestBefore = statSync(join(store, "blobs", `${a.id}.manifest`)).mtimeMs;
    expect(await put(data)).toEqual(a);
    expect(chunkBytes(store)).toBe(before); expect(statSync(join(store, "blobs", `${a.id}.manifest`)).mtimeMs).toBe(manifestBefore);
  });

  it("GEODE_HUB_CHUNKED=0 writes whole files, which chunkLegacyBlob converts in place", async () => {
    process.env.GEODE_HUB_CHUNKED = "0";
    const data = randomBytes(3 * MIB + 7), ref = await put(data);
    expect(statSync(join(store, "blobs", ref.id)).size).toBe(data.length); expect(chunkFiles(store)).toHaveLength(0);
    delete process.env.GEODE_HUB_CHUNKED;
    expect(await session.chunkLegacyBlob(ref.id)).toEqual({ status: "chunked", legacyBytes: data.length, newChunkBytes: data.length });
    expect(existsSync(join(store, "blobs", ref.id))).toBe(false); await equal(ref, data);
    expect(await session.chunkLegacyBlob(ref.id)).toMatchObject({ status: "already-chunked" });
    expect(await session.chunkLegacyBlob(sha(new Uint8Array([9])))).toMatchObject({ status: "missing" });
  });

  it("migration dedupes across legacy versions and leaves small and corrupt blobs alone", async () => {
    process.env.GEODE_HUB_CHUNKED = "0";
    const v1 = randomBytes(4 * MIB), v2 = concat(v1, randomBytes(50_000)), small = randomBytes(1000);
    const [r1, r2, rs] = [await put(v1), await put(v2), await put(small)];
    const bad = createHash("sha256").update("not the content").digest("hex"); writeFileSync(join(store, "blobs", bad), randomBytes(3 * MIB));
    delete process.env.GEODE_HUB_CHUNKED;
    expect(await session.chunkLegacyBlob(r1.id)).toMatchObject({ status: "chunked", newChunkBytes: 4 * MIB });
    expect(await session.chunkLegacyBlob(r2.id)).toMatchObject({ status: "chunked", legacyBytes: v2.length, newChunkBytes: 50_000 });
    expect(await session.chunkLegacyBlob(rs.id)).toMatchObject({ status: "too-small" });
    expect(await session.chunkLegacyBlob(bad)).toMatchObject({ status: "corrupt" });
    expect(existsSync(join(store, "blobs", bad))).toBe(true); expect(existsSync(join(store, "blobs", rs.id))).toBe(true);
    await equal(r1, v1); await equal(r2, v2); await equal(rs, small);
  });

  it("detects a missing or damaged chunk instead of returning wrong bytes", async () => {
    const data = randomBytes(3 * MIB), ref = await put(data), [first, second] = chunkFiles(store);
    truncateSync(first, 10);
    await expect(session.readBlob(ref, never)).rejects.toMatchObject({ code: expect.stringMatching(/hash-mismatch|not-found/) });
    rm(second);
    await expect(session.readBlob(ref, never)).rejects.toBeTruthy();
    // a damaged blob is re-storable: the existence check notices the missing chunk and the next put heals it
    expect(await put(data)).toEqual(ref); await equal(ref, data);
  });

  it("a record can reference a chunked blob (appendRecord checks its size)", async () => {
    const data = randomBytes(4 * MIB), ref = await put(data);
    await session.appendRecord(record(binding.vaultId, randomUUID(), ref), never);
    const scan = await session.scan(undefined, never);
    expect(scan.records).toHaveLength(1);
  });

  it("works through the RPC server (streaming upload + ranged reads)", async () => {
    const provider = inProcessProvider(store), rpc = await provider.open({ binding, deviceId: "rpc" }, never);
    try {
      const data = randomBytes(9 * MIB + 3), ref = await rpc.putBlob({ operationId: randomUUID(), sha256: sha(data), size: data.length, data: buf(data) }, never);
      expect(existsSync(join(store, "blobs", `${ref.id}.manifest`))).toBe(true);
      expect(Buffer.from(await rpc.readBlob(ref, never)).equals(Buffer.from(data))).toBe(true);
    } finally { await rpc.close(); }
  });
});

describe("sweepOrphanChunks", () => {
  it("reports orphans, only removes old ones with apply, and keeps referenced chunks", async () => {
    const data = randomBytes(3 * MIB), ref = await put(data), referenced = chunkFiles(store).length;
    const dir = join(store, "chunks", "ab"); mkdirSync(dir, { recursive: true });
    const old = join(dir, "a".repeat(64)), young = join(dir, "b".repeat(64));
    writeFileSync(old, "orphan"); writeFileSync(young, "inflight");
    const past = new Date(Date.now() - 3 * 3600_000); utimesSync(old, past, past);
    expect(await sweepOrphanChunks(store, { apply: false })).toEqual({ referenced, orphans: 1, orphanBytes: 6, removed: 0 });
    expect(existsSync(old)).toBe(true);
    expect(await sweepOrphanChunks(store, { apply: true })).toMatchObject({ orphans: 1, removed: 1 });
    expect(existsSync(old)).toBe(false); expect(existsSync(young)).toBe(true); expect(chunkFiles(store).length).toBe(referenced + 1);
    await equal(ref, data);
  });

  it("refuses to delete anything when a manifest is unreadable", async () => {
    const ref = await put(randomBytes(3 * MIB));
    const dir = join(store, "chunks", "cd"); mkdirSync(dir, { recursive: true });
    const orphan = join(dir, "c".repeat(64)); writeFileSync(orphan, "x"); utimesSync(orphan, new Date(0), new Date(0));
    appendFileSync(join(store, "blobs", `${ref.id}.manifest`), "garbage");
    expect(await sweepOrphanChunks(store, { apply: true })).toMatchObject({ removed: 0, refused: expect.stringContaining("unreadable manifest") });
    expect(existsSync(orphan)).toBe(true);
  });
});
