import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFilesystemObjectStore,
  createMemoryObjectStore,
  objectKeyFor,
  putImmutable,
  readVerified,
  type ObjectStore,
} from "../../src/catalog/object-store";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff]);
const address = sha(bytes);

let directory = "";
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "geode-object-store-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

/**
 * Both Phase A implementations are held to the same contract.
 *
 * Running one suite over both is the point: the seam exists so Phase B can drop
 * a Vercel Blob implementation in without the adapter noticing, and that is only
 * true if "the object store contract" means something more than "whatever the
 * one implementation happens to do".
 */
describe.each([
  ["memory", () => createMemoryObjectStore()],
  ["filesystem", () => createFilesystemObjectStore(join(directory, `fs-${Math.random().toString(36).slice(2)}`))],
])("%s object store", (_name, make) => {
  it("round-trips bytes exactly", async () => {
    const store = make();
    await store.put("v/objects/a", bytes, "image/png");
    expect([...(await store.get("v/objects/a"))!]).toEqual([...bytes]);
  });

  it("answers absence with null rather than throwing", async () => {
    expect(await make().get("v/objects/missing")).toBeNull();
  });

  it("returns the key the store assigned", async () => {
    // Vercel Blob may append a random suffix; the caller records what came
    // back, never what it asked for.
    expect(await make().put("v/objects/a", bytes, "image/png")).toBe("v/objects/a");
  });

  it("lists by prefix and deletes", async () => {
    const store = make();
    await store.put("v1/objects/a", bytes, "image/png");
    await store.put("v1/objects/b", bytes, "image/png");
    await store.put("v2/objects/c", bytes, "image/png");
    expect(await store.list("v1/")).toEqual(["v1/objects/a", "v1/objects/b"]);
    await store.delete("v1/objects/a");
    expect(await store.list("v1/")).toEqual(["v1/objects/b"]);
  });

  it("does not let a caller mutate what the store already holds", async () => {
    // A filesystem store physically cannot be made to do this, so the in-memory
    // one must not either — otherwise a test that passes against memory would
    // be proving something the real implementation does not do.
    const store = make();
    const mutable = new Uint8Array([1, 2, 3]);
    await store.put("v/objects/m", mutable, "application/octet-stream");
    mutable[0] = 99;
    expect((await store.get("v/objects/m"))![0]).toBe(1);
  });
});

describe("objectKeyFor", () => {
  it("namespaces by vault so one vault can be listed without scanning another", () => {
    expect(objectKeyFor("vault-a", address)).toBe(`vault-a/objects/${address}`);
  });
});

describe("the filesystem store refuses an unsafe key", () => {
  it.each([["../escape"], ["/absolute"], ["a//b"], [".hidden"], ["a/../b"]])("refuses %s", async (key) => {
    // Both segments are already constrained by the contract's identifier and
    // content-address patterns, and the store re-checks anyway: it is a store,
    // and a store checks its inputs at the boundary.
    await expect(createFilesystemObjectStore(directory).put(key, bytes, "text/plain")).rejects.toThrow(/not a safe relative key/);
  });
});

describe("readVerified", () => {
  it("returns bytes when they hash to the address asked for", async () => {
    const store = createMemoryObjectStore();
    await store.put("k", bytes, "image/png");
    expect(await readVerified(store, "k", address)).toEqual({ status: "ok", bytes });
  });

  it("names an absent object rather than returning empty bytes", async () => {
    const result = await readVerified(createMemoryObjectStore(), "k", address);
    expect(result).toEqual({ status: "absent", key: "k", contentAddress: address });
  });

  it("refuses bytes that do not hash to the address they were filed under", async () => {
    // The check that makes "content-addressed" a guarantee on the read path.
    // This is the only integrity check a *note* ever gets: `verifyRestoredVault`
    // has no content address for a note to recompute.
    const store = createMemoryObjectStore();
    await store.put("k", new Uint8Array([9, 9, 9]), "image/png");
    expect((await readVerified(store, "k", address)).status).toBe("address-mismatch");
  });

  it("names a failing store rather than laundering it into absence", async () => {
    const broken: ObjectStore = {
      async put() { throw new Error("nope"); },
      async get() { throw new Error("unreachable"); },
      async delete() { throw new Error("nope"); },
      async list() { throw new Error("nope"); },
    };
    expect((await readVerified(broken, "k", address)).status).toBe("store-failed");
  });

  it("reads through a substituted digest", async () => {
    // The `Digest` seam is honoured here as it is in the contract, so a caller
    // that substituted one does not silently get `node:crypto` at this layer.
    const store = createMemoryObjectStore();
    await store.put("k", bytes, "image/png");
    const always = { sha256Hex: () => "f".repeat(64) };
    expect((await readVerified(store, "k", "f".repeat(64), always)).status).toBe("ok");
    expect((await readVerified(store, "k", address, always)).status).toBe("address-mismatch");
  });
});

describe("putImmutable", () => {
  it("converges when two cold uploads race on an exclusive-create store", async () => {
    const memory = createMemoryObjectStore();
    let reads = 0;
    let release!: () => void;
    const bothAbsent = new Promise<void>((resolve) => { release = resolve; });
    let created = false;
    let writes = 0;
    const store: ObjectStore = {
      ...memory,
      async get(key) {
        if (++reads <= 2) {
          if (reads === 2) release();
          await bothAbsent;
          return null;
        }
        return memory.get(key);
      },
      async put(key, value, type) {
        if (created) throw new Error("already exists");
        created = true;
        writes++;
        return memory.put(key, value, type);
      },
    };
    expect(await Promise.all([
      putImmutable(store, "k", bytes, "image/png", address),
      putImmutable(store, "k", bytes, "image/png", address),
    ])).toEqual([{ status: "ok", key: "k" }, { status: "ok", key: "k" }]);
    expect(writes).toBe(1);
  });

  it.each(["mismatch", "absent", "outage", "digest-collision"] as const)(
    "does not accept an unverified winner after a failed put: %s", async (failure) => {
      let reads = 0;
      const store: ObjectStore = {
        async get() {
          if (++reads === 1 || failure === "absent") return null;
          if (failure === "outage") throw new Error("unreachable");
          return new Uint8Array([9]);
        },
        async put() { throw new Error("already exists or interrupted"); },
        async delete() {}, async list() { return []; },
      };
      const digest = failure === "digest-collision" ? { sha256Hex: () => address } : undefined;
      expect(await putImmutable(store, "k", bytes, "image/png", address, digest)).toEqual({
        status: failure === "mismatch" || failure === "digest-collision"
          ? "duplicate-with-mismatched-bytes" : "store-failed",
      });
    },
  );

  it("writes an absent object", async () => {
    const store = createMemoryObjectStore();
    expect(await putImmutable(store, "k", bytes, "image/png", address)).toEqual({ status: "ok", key: "k" });
    expect(store.size()).toBe(1);
  });

  it("is idempotent for identical bytes and does not rewrite", async () => {
    const store = createMemoryObjectStore();
    await putImmutable(store, "k", bytes, "image/png", address);
    let writes = 0;
    const counting: ObjectStore = { ...store, async put(key, value, type) { writes += 1; return store.put(key, value, type); } };
    expect(await putImmutable(counting, "k", bytes, "image/png", address)).toEqual({ status: "ok", key: "k" });
    expect(writes).toBe(0);
  });

  it("refuses to let one content address come to mean two byte strings", async () => {
    // This is the replacement for the PostgreSQL schema's immutability trigger,
    // and it is a check rather than a lock. It catches the case the trigger
    // caught; it does not *prevent* a writer that never calls it.
    const store = createMemoryObjectStore();
    await store.put("k", new Uint8Array([7, 7]), "image/png");
    expect(await putImmutable(store, "k", bytes, "image/png", address))
      .toEqual({ status: "duplicate-with-mismatched-bytes" });
    // And the pre-existing bytes are untouched: a refusal is not a repair.
    expect([...(await store.get("k"))!]).toEqual([7, 7]);
  });

  it("reports a failing store without writing", async () => {
    const broken: ObjectStore = {
      async put() { return "k"; },
      async get() { throw new Error("unreachable"); },
      async delete() {}, async list() { return []; },
    };
    expect(await putImmutable(broken, "k", bytes, "image/png", address)).toEqual({ status: "store-failed" });
  });

  it("reports a store that fails on write", async () => {
    const store = createMemoryObjectStore();
    const failing: ObjectStore = { ...store, async put() { throw new Error("quota"); } };
    expect(await putImmutable(failing, "k", bytes, "image/png", address)).toEqual({ status: "store-failed" });
  });
});

describe("the filesystem store ignores files outside the prefix it was asked for", () => {
  it("lists only matching keys even when other vaults are present", async () => {
    const root = join(directory, "prefixed");
    const store = createFilesystemObjectStore(root);
    await store.put("vault-a/objects/one", bytes, "image/png");
    await store.put("vault-b/objects/two", bytes, "image/png");
    expect(await store.list("vault-a/")).toEqual(["vault-a/objects/one"]);
  });

  it("returns an empty list for a root that does not exist yet", async () => {
    expect(await createFilesystemObjectStore(join(directory, "never-created")).list("")).toEqual([]);
  });

  it("surfaces a read failure that is not absence", async () => {
    // A directory where a file is expected is not "no object here" — it is the
    // store being wrong about its own shape, and must not read as absence.
    const root = join(directory, "shape");
    const store = createFilesystemObjectStore(root);
    await store.put("v/objects/a", bytes, "image/png");
    await rm(join(root, "v/objects/a"));
    await mkdir(join(root, "v/objects/a"));
    await expect(store.get("v/objects/a")).rejects.toThrow();
  });
});
