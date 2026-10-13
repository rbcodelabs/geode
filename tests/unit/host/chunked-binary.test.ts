import { describe, expect, it } from "vitest";
import { FileChangedDuringReadError, readPrivateBinary, readVaultBinary, writePrivateBinary, writeVaultBinary } from "../../../src/renderer/host/chunked-binary";
import { SyncBlockedError } from "../../../src/sync-core/ports";
import { FakeManagedVault } from "../../helpers/fake-managed-vault";

// Tiny limits so the tests exercise many chunks without moving real megabytes: the fake native plugin enforces `bridgeLimit`.
const TUNING = { chunkBytes: 1000, singleCallBytes: 4000, maxBytes: 50_000 };
const OP = "11111111-1111-4111-8111-111111111111";
const pattern = (size: number) => Uint8Array.from({ length: size }, (_, index) => (index * 31 + 7) % 251);
const same = (a: ArrayBuffer | Uint8Array, b: Uint8Array) => { const bytes = a instanceof Uint8Array ? a : new Uint8Array(a); return bytes.byteLength === b.byteLength && bytes.every((value, index) => value === b[index]); };
function vault() { const native = new FakeManagedVault(); native.bridgeLimit = TUNING.singleCallBytes; return native; }

describe("chunked vault reads", () => {
  it("keeps the single call for files that fit and ranges the rest, byte for byte", async () => {
    const native = vault(); native.put("small.bin", pattern(3000)).put("dir/big.bin", pattern(23_456));
    expect(same(await readVaultBinary(native.plugin, "small.bin", TUNING), pattern(3000))).toBe(true);
    expect(native.calls.some(call => call.startsWith("readBinaryRange"))).toBe(false);
    native.calls.length = 0;
    expect(same(await readVaultBinary(native.plugin, "dir/big.bin", TUNING), pattern(23_456))).toBe(true);
    expect(native.calls.filter(call => call.startsWith("readBinaryRange"))).toHaveLength(24);
  });

  it("refuses to return a torn file when it changes between chunks", async () => {
    const native = vault(); native.put("big.bin", pattern(10_000));
    const range = native.plugin.readBinaryRange!.bind(native.plugin); let calls = 0;
    native.plugin.readBinaryRange = async options => { if (++calls === 3) native.mtime++; return range(options); };
    const error = await readVaultBinary(native.plugin, "big.bin", TUNING).catch(caught => caught);
    expect(error).toBeInstanceOf(FileChangedDuringReadError); expect(error).toBeInstanceOf(SyncBlockedError); expect(error.syncBlockedReason).toBe("changed-during-read");
  });

  it("fails a file that shrinks mid-read, and a file over the cap, with the native code", async () => {
    const native = vault(); native.put("shrinks.bin", pattern(10_000)).put("huge.bin", pattern(60_000));
    const range = native.plugin.readBinaryRange!.bind(native.plugin); let calls = 0;
    native.plugin.readBinaryRange = async options => { const result = await range(options); return ++calls === 2 ? { ...result, base64: "", size: result.size } : result; };
    await expect(readVaultBinary(native.plugin, "shrinks.bin", TUNING)).rejects.toBeInstanceOf(FileChangedDuringReadError);
    native.chunked = true;
    await expect(readVaultBinary(native.plugin, "huge.bin", TUNING)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("a native build without ranged reads keeps today's behaviour (the single-call error reaches the caller)", async () => {
    const native = vault(); native.put("big.bin", pattern(10_000)); native.chunked = false;
    await expect(readVaultBinary(native.plugin, "big.bin", TUNING)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });
});

describe("chunked vault writes", () => {
  it("assembles in a temp and publishes only at commit, replacing existing bytes atomically", async () => {
    const native = vault(); native.put("dir/big.bin", pattern(100));
    let visibleDuringTransfer: Uint8Array | undefined;
    native.beforeChunk = offset => { if (offset === 9000) visibleDuringTransfer = native.files.get("dir/big.bin"); };
    await writeVaultBinary(native.plugin, "dir/big.bin", pattern(12_345).buffer as ArrayBuffer, OP, TUNING);
    expect(same(visibleDuringTransfer!, pattern(100))).toBe(true); // the old file was untouched until the swap
    expect(same(native.files.get("dir/big.bin")!, pattern(12_345))).toBe(true);
    expect(native.chunkTemps.size).toBe(0);
    expect(native.calls.at(-1)).toBe("writeBinaryCommit dir/big.bin");
    expect(native.calls.filter(call => call.startsWith("writeBinaryChunk"))).toHaveLength(13);
  });

  it("single-call writes stay single-call", async () => {
    const native = vault(); native.put("a/x", "x");
    await writeVaultBinary(native.plugin, "a/small.bin", pattern(3999).buffer as ArrayBuffer, OP, TUNING);
    expect(native.calls).toEqual(["writeBinary a/small.bin"]);
  });

  it("aborts and leaves the target untouched when a chunk fails; a retry restarts cleanly", async () => {
    const native = vault(); native.put("dir/big.bin", pattern(100));
    let failures = 1;
    native.beforeChunk = offset => { if (offset === 5000 && failures-- > 0) throw Object.assign(new Error("bridge died"), { code: "IO_FAILURE" }); };
    await expect(writeVaultBinary(native.plugin, "dir/big.bin", pattern(12_000).buffer as ArrayBuffer, OP, TUNING)).rejects.toThrow("bridge died");
    expect(same(native.files.get("dir/big.bin")!, pattern(100))).toBe(true);
    expect(native.chunkTemps.size).toBe(0); expect(native.calls).toContain("writeBinaryAbort dir/big.bin");
    await writeVaultBinary(native.plugin, "dir/big.bin", pattern(12_000).buffer as ArrayBuffer, OP, TUNING);
    expect(same(native.files.get("dir/big.bin")!, pattern(12_000))).toBe(true);
  });

  it("a crash mid-transfer (no abort possible) leaves only a temp; the same operation restarts it from offset 0", async () => {
    const native = vault();
    native.put("dir/x", "x");
    native.beforeChunk = offset => { if (offset === 4000) throw new Error("app killed"); };
    native.plugin.writeBinaryAbort = async () => { throw new Error("app killed"); };
    await expect(writeVaultBinary(native.plugin, "dir/big.bin", pattern(9000).buffer as ArrayBuffer, OP, TUNING)).rejects.toThrow("app killed");
    expect(native.files.has("dir/big.bin")).toBe(false); expect(native.chunkTemps.size).toBe(1);
    native.beforeChunk = undefined;
    await writeVaultBinary(native.plugin, "dir/big.bin", pattern(9000).buffer as ArrayBuffer, OP, TUNING);
    expect(same(native.files.get("dir/big.bin")!, pattern(9000))).toBe(true); expect(native.chunkTemps.size).toBe(0);
  });

  it("refuses files over the cap, and over the bridge limit on a native build without chunked writes", async () => {
    const native = vault(); native.put("dir/x", "x");
    await expect(writeVaultBinary(native.plugin, "dir/big.bin", pattern(60_000).buffer as ArrayBuffer, OP, TUNING)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    native.chunked = false;
    await expect(writeVaultBinary(native.plugin, "dir/big.bin", pattern(9000).buffer as ArrayBuffer, OP, TUNING)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(native.files.has("dir/big.bin")).toBe(false);
  });
});

describe("chunked sync-private storage", () => {
  it("round-trips a file over the bridge limit and only publishes it on the final chunk", async () => {
    const native = vault(); let atLastChunk: Uint8Array | undefined;
    native.beforeChunk = offset => { if (offset === 11_000) atLastChunk = native.privateFiles.get("b/op.blob"); };
    await writePrivateBinary(native.plugin as never, "b/op.blob", pattern(11_500), TUNING);
    expect(atLastChunk).toBeUndefined();
    expect(same(await readPrivateBinary(native.plugin as never, "b/op.blob", TUNING) as Uint8Array, pattern(11_500))).toBe(true);
    expect(await readPrivateBinary(native.plugin as never, "b/missing", TUNING)).toBeNull();
  });

  it("small files stay single-call; an old native build cannot store a big one", async () => {
    const native = vault();
    await writePrivateBinary(native.plugin as never, "b/small", pattern(10), TUNING);
    expect(native.privateChunkTemps.size).toBe(0);
    native.chunked = false;
    await expect(writePrivateBinary(native.plugin as never, "b/op.blob", pattern(9000), TUNING)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });
});
