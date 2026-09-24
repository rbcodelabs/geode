import { describe, expect, it, vi } from "vitest";
import { createMemoryObjectStore } from "../../src/catalog/object-store";
import { createDocumentStore } from "../../src/documents/index";

function setup(maxContentBytes = 1024) {
  const objects = createMemoryObjectStore();
  return { objects, store: createDocumentStore({ namespace: "workspace-a", objects, maxContentBytes }) };
}

describe("immutable document content", () => {
  it.each(["", "\uFEFF# café 🦎\r\n\n ", "plain markdown"])("preserves exact text %j across handles", async text => {
    const { objects, store } = setup();
    const result = await store.putContent(text);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("put failed");
    const reopened = createDocumentStore({ namespace: "workspace-a", objects, maxContentBytes: 1024 });
    expect(await reopened.readContent(JSON.parse(JSON.stringify(result.reference)))).toEqual({ status: "ok", text });
    expect(result.reference.byteLength).toBe(Buffer.byteLength(text));
    expect(await store.putContent(text)).toEqual(result);
    expect(objects.size()).toBe(1);
  });

  it("rejects foreign and malformed references before storage access", async () => {
    const { store, objects } = setup();
    const written = await store.putContent("body");
    if (written.status !== "ok") throw new Error("put failed");
    const get = vi.spyOn(objects, "get");
    expect(await store.readContent({ ...written.reference, namespace: "workspace-b" })).toEqual({ status: "namespace-mismatch" });
    for (const bad of [null, {}, "https://evil.example/x", { ...written.reference, digest: "../x" }, { ...written.reference, version: 2 }, { ...written.reference, byteLength: -1 }]) {
      expect(await store.readContent(bad)).toEqual({ status: "invalid" });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("bounds UTF-8 bytes and rejects lossy lone surrogates", async () => {
    const { store } = setup(3);
    expect(await store.putContent("éé")).toEqual({ status: "oversized" });
    expect(await store.putContent("\uD800")).toEqual({ status: "invalid" });
  });

  it("distinguishes missing, corruption, length tampering and unavailable storage", async () => {
    const { store, objects } = setup();
    const result = await store.putContent("body");
    if (result.status !== "ok") throw new Error("put failed");
    expect(await store.readContent({ ...result.reference, byteLength: 3 })).toEqual({ status: "integrity-failure" });
    const key = (await objects.list(""))[0];
    await objects.put(key, new Uint8Array([1]), "text/markdown");
    expect(await store.readContent(result.reference)).toEqual({ status: "integrity-failure" });
    expect(await store.putContent("body")).toEqual({ status: "integrity-failure" });
    await objects.delete(key);
    expect(await store.readContent(result.reference)).toEqual({ status: "missing" });
    vi.spyOn(objects, "get").mockRejectedValue(new Error("secret endpoint"));
    expect(await store.readContent(result.reference)).toEqual({ status: "unavailable" });
    expect(await store.putContent("body")).toEqual({ status: "unavailable" });
  });

  it("verifies storage after upload and recovers a lost upload response", async () => {
    const { store, objects } = setup();
    const realPut = objects.put.bind(objects);
    vi.spyOn(objects, "put").mockImplementation(async (...args) => { await realPut(...args); throw new Error("lost response"); });
    expect((await store.putContent("body")).status).toBe("ok");
    objects.put = async () => "wrong-key";
    expect(await store.putContent("new body")).toEqual({ status: "integrity-failure" });
  });

  it("recovers concurrent exclusive-create races without overwriting", async () => {
    const { store, objects } = setup();
    const put = objects.put.bind(objects);
    const written = new Set<string>();
    objects.put = async (key, bytes, type) => {
      if (written.has(key)) throw new Error("already exists");
      written.add(key);
      return put(key, bytes, type);
    };
    const results = await Promise.all([store.putContent("same"), store.putContent("same")]);
    expect(results[0].status).toBe("ok");
    expect(results[1]).toEqual(results[0]);
    expect(objects.size()).toBe(1);
  });

  it("refuses acknowledged but missing uploads and never exposes adapter errors", async () => {
    const { store, objects } = setup();
    objects.put = async key => key;
    expect(await store.putContent("not saved")).toEqual({ status: "unavailable" });
    objects.put = async () => { throw new Error("private credential details"); };
    expect(await store.putContent("not saved")).toEqual({ status: "unavailable" });
  });

  it("rejects references larger than policy without fetching them", async () => {
    const { store, objects } = setup(3);
    const get = vi.spyOn(objects, "get");
    expect(await store.readContent({ version: 1, namespace: "workspace-a", digest: "a".repeat(64), byteLength: 4 })).toEqual({ status: "oversized" });
    expect(get).not.toHaveBeenCalled();
  });

  it("validates namespace and numeric configuration at construction", () => {
    const objects = createMemoryObjectStore();
    for (const namespace of ["", "../escape", "a/b", "a".repeat(129)]) {
      expect(() => createDocumentStore({ namespace, objects, maxContentBytes: 1 })).toThrow("Invalid document store configuration");
    }
    for (const maxContentBytes of [0, -1, NaN, Infinity, 0.5]) {
      expect(() => createDocumentStore({ namespace: "valid", objects, maxContentBytes })).toThrow("Invalid document store configuration");
    }
    expect(() => createDocumentStore({ namespace: undefined as unknown as string, objects, maxContentBytes: 1 })).toThrow("Invalid document store configuration");
  });
});
