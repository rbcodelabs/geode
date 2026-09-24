import { ReadableStream } from "node:stream/web";
import { describe, expect, it, vi } from "vitest";
import { createPrivateBlobStore } from "../../src/catalog/private-blob-store";

const key = `vault/objects/${"a".repeat(64)}`;
const prefix = "geode_wiki_preview_0123456789abcdef/";
function fixture(overrides = {}) {
  const sdk = {
    put: vi.fn(async (pathname: string) => ({ pathname })),
    get: vi.fn(async () => null as unknown),
    del: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ blobs: [], hasMore: false })),
  };
  const beforeWrite = vi.fn(async () => undefined);
  const store = createPrivateBlobStore({ prefix, token: "synthetic-token", maxObjectBytes: 8,
    maxReadBytes: 16, maxUploadedBytes: 176, maxOperations: 40, timeoutMs: 500,
    beforeWrite, sdk, ...overrides });
  return { store, sdk, beforeWrite };
}
function response(bytes: number[], size = bytes.length, pathname = prefix + key, headers = new Headers({ "content-length": String(size) })) {
  return { statusCode: 200, headers, blob: { size, pathname }, stream: new ReadableStream({
    start(controller) { controller.enqueue(Uint8Array.from(bytes)); controller.close(); },
  }) };
}
describe("private Blob boundary", () => {
  it("records the exact pathname before exclusive private upload", async () => {
    const { store, sdk, beforeWrite } = fixture();
    expect(await store.put(key, new Uint8Array([1, 2]), "text/plain")).toBe(key);
    expect(beforeWrite).toHaveBeenCalledWith(prefix + key);
    expect(beforeWrite.mock.invocationCallOrder[0]).toBeLessThan(sdk.put.mock.invocationCallOrder[0]);
    expect(sdk.put).toHaveBeenCalledWith(prefix + key, expect.any(Uint8Array), expect.objectContaining({
      access: "private", addRandomSuffix: false, allowOverwrite: false, token: "synthetic-token",
    }));
  });
  it("refuses altered assigned keys", async () => {
    const { store, sdk } = fixture();
    sdk.put.mockResolvedValue({ pathname: prefix + key + "-suffix" });
    await expect(store.put(key, new Uint8Array([1]), "text/plain")).rejects.toThrow(/pathname/);
  });
  it("does not upload if durable inventory fails", async () => {
    const { store, sdk, beforeWrite } = fixture();
    beforeWrite.mockRejectedValue(new Error("disk unavailable"));
    await expect(store.put(key, new Uint8Array([1]), "text/plain")).rejects.toThrow();
    expect(sdk.put).not.toHaveBeenCalled();
  });
  it("times out inventory and does not upload when it later finishes", async () => {
    const { store, sdk, beforeWrite } = fixture({ timeoutMs: 10 });
    let release!: () => void;
    beforeWrite.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    await expect(store.put(key, new Uint8Array([1]), "text/plain")).rejects.toThrow(/failed/);
    release(); await new Promise(resolve => setTimeout(resolve, 1));
    expect(sdk.put).not.toHaveBeenCalled();
  });
  it("cancels a late stream after timeout without reading or refunding its reservation", async () => {
    const { store, sdk } = fixture({ timeoutMs: 10, maxReadBytes: 8 });
    let release!: (value: unknown) => void;
    sdk.get.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    await expect(store.get(key)).rejects.toThrow(/failed/);
    const cancel = vi.fn();
    release({ statusCode: 200, headers: new Headers({ "content-length": "1" }), blob: { size: 1, pathname: prefix + key }, stream: new ReadableStream({ cancel }) });
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(cancel).toHaveBeenCalledOnce();
    await expect(store.get(key)).rejects.toThrow(/budget/);
  });
  it.each(["../outside", "/root", `../objects/${"a".repeat(64)}`, "https://elsewhere"])('rejects unsafe key %s before IO', async unsafe => {
    const { store, sdk } = fixture();
    await expect(store.get(unsafe)).rejects.toThrow();
    expect(sdk.get).not.toHaveBeenCalled();
  });
  it("reads uncached private bytes", async () => {
    const { store, sdk } = fixture(); sdk.get.mockResolvedValue(response([1, 2]));
    expect(await store.get(key)).toEqual(new Uint8Array([1, 2]));
    expect(sdk.get).toHaveBeenCalledWith(prefix + key, expect.objectContaining({ access: "private", useCache: false }));
  });
  it("accepts decoded bytes when Content-Length describes gzip transport bytes", async () => {
    const { store, sdk } = fixture();
    // SDK 2.8.0 exposes fetch's decoded body but derives blob.size from this
    // retained encoded Content-Length. Headers names are case-insensitive.
    sdk.get.mockResolvedValue(response([1, 2, 3, 4], 2, prefix + key,
      new Headers({ "Content-Encoding": "gzip", "Content-Length": "2" })));
    expect(await store.get(key)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(store.metrics().readBytes).toBe(4);
    expect(store.metrics()).toMatchObject({ encodedResponses: 1, unknownLengthResponses: 0 });
  });
  it("accepts bounded decoded bytes when Content-Length is absent and SDK size is zero", async () => {
    const { store, sdk } = fixture();
    sdk.get.mockResolvedValue(response([1, 2], 0, prefix + key, new Headers()));
    expect(await store.get(key)).toEqual(new Uint8Array([1, 2]));
    expect(store.metrics()).toMatchObject({ encodedResponses: 0, unknownLengthResponses: 1 });
  });
  it("does not reject a small decoded object solely because compressed wire length exceeds the decoded cap", async () => {
    const { store, sdk } = fixture();
    sdk.get.mockResolvedValue(response([1], 21, prefix + key,
      new Headers({ "content-encoding": "gzip", "content-length": "21" })));
    expect(await store.get(key)).toEqual(new Uint8Array([1]));
  });
  it.each(["gzip", "br", "deflate"])("still bounds actual decoded bytes for %s", async encoding => {
    const { store, sdk } = fixture();
    sdk.get.mockResolvedValue(response(new Array(9).fill(1), 1, prefix + key,
      new Headers({ "content-encoding": encoding, "content-length": "1" })));
    await expect(store.get(key)).rejects.toThrow(/failed/);
    expect(store.metrics().readBytes).toBe(9);
  });
  it("retains exact length verification for explicit identity encoding", async () => {
    const { store, sdk } = fixture();
    sdk.get.mockResolvedValue(response([1], 2, prefix + key,
      new Headers({ "Content-Encoding": "identity", "Content-Length": "2" })));
    await expect(store.get(key)).rejects.toThrow(/failed/);
  });
  it("refuses oversized metadata and streams lying about their size", async () => {
    const { store, sdk } = fixture();
    sdk.get.mockResolvedValue(response([1], 9));
    await expect(store.get(key)).rejects.toThrow(/failed/);
    sdk.get.mockResolvedValue(response([1, 2, 3, 4, 5, 6, 7, 8, 9], 1));
    await expect(store.get(key)).rejects.toThrow(/failed/);
  });
  it("refuses wrong read pathname or truncated bytes", async () => {
    const { store, sdk } = fixture(); sdk.get.mockResolvedValue(response([1], 1, "outside"));
    await expect(store.get(key)).rejects.toThrow(/failed/);
    sdk.get.mockResolvedValue(response([1], 2));
    await expect(store.get(key)).rejects.toThrow(/failed/);
  });
  it("charges an oversized chunk even when the read is refused", async () => {
    const { store, sdk } = fixture();
    sdk.get.mockResolvedValue(response(new Array(9).fill(1), 8));
    await expect(store.get(key)).rejects.toThrow(/failed/);
    await expect(store.get(key)).rejects.toThrow(/budget/);
    expect(sdk.get).toHaveBeenCalledOnce();
  });
  it("charges oversized bytes even if stream cancellation never completes", async () => {
    const { store, sdk } = fixture({ timeoutMs: 10 });
    sdk.get.mockResolvedValue({ statusCode: 200, headers: new Headers({ "content-length": "8" }), blob: { size: 8, pathname: prefix + key }, stream: new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel() { return new Promise(() => undefined); },
    }) });
    await expect(store.get(key)).rejects.toThrow(/failed/);
    await expect(store.get(key)).rejects.toThrow(/budget/);
    expect(sdk.get).toHaveBeenCalledOnce();
  });
  it("reserves concurrent upload budget before IO", async () => {
    const { store, sdk } = fixture({ maxUploadedBytes: 33 });
    const results = await Promise.allSettled([store.put(key,new Uint8Array(2),"x"),store.put(key,new Uint8Array(2),"x")]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(sdk.put).toHaveBeenCalledTimes(1);
  });
  it("reserves whole SDK retry allowance before an operation", async () => {
    const { store, sdk } = fixture({ maxOperations: 1 });
    await expect(store.get(key)).rejects.toThrow(/budget/);
    expect(sdk.get).not.toHaveBeenCalled();
  });
  it("refuses inventory listing beyond its bounded page", async () => {
    const { store, sdk } = fixture(); sdk.list.mockResolvedValue({ blobs: [], hasMore: true });
    await expect(store.list("vault/")).rejects.toThrow(/listing/);
  });
});
