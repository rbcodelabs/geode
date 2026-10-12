import { describe, expect, it, vi } from "vitest";
import { createBrowserHost, createBrowserHostState } from "../../../src/renderer/host/browser-host";
import { createCapacitorHost, splitICloudPlaceholders } from "../../../src/renderer/host/capacitor-host";
import { base64ToBytes, bytesToBase64 } from "../../../src/renderer/host/base64";
import { createMobileSyncSafety, sha256Hex, type MobileSyncPorts } from "../../../src/renderer/host/mobile-sync-safety";
import type { GuardedMutation, SyncSafetyService } from "../../../src/shared/sync-safety";
import { SyncBlockedError } from "../../../src/sync-core/ports";
import { FakeManagedVault } from "../../helpers/fake-managed-vault";

const BINDING = "a".repeat(64);
const uuid = () => crypto.randomUUID();
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const hash = (text: string) => sha256Hex(new TextEncoder().encode(text));

async function open() {
  const vault = new FakeManagedVault();
  const host = createCapacitorHost(vault.plugin, createBrowserHost(createBrowserHostState()));
  await host.vaultRegistry.openVault("managed://default");
  const safety = host.syncSafety!;
  const token = (await safety.claimOwner())!;
  return { vault, host, safety, token };
}
const write = (path: string, text: string, expectedHash: string | null, operationId = uuid()): GuardedMutation => ({ operationId, path, expectedHash, kind: "write", data: bytes(text) });

describe("mobile host.syncSafety exists only where the native plugin can back it", () => {
  it("is present with the guarded-sync primitives and absent on an older native build", () => {
    const vault = new FakeManagedVault();
    expect(createCapacitorHost(vault.plugin, createBrowserHost(createBrowserHostState())).syncSafety).toBeDefined();
    const old = { ...vault.plugin } as Record<string, unknown>; delete old.stat;
    expect(createCapacitorHost(old as never, createBrowserHost(createBrowserHostState())).syncSafety).toBeUndefined();
  });
});

describe("owner lease", () => {
  it("claims once per open vault, hands the same token back to the same window, and releases", async () => {
    const { safety, token, vault, host } = await open();
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await safety.claimOwner()).toBe(token);
    await safety.releaseOwner(token);
    const next = await safety.claimOwner();
    expect(next).not.toBe(token);
    vault.put("a.md", "x");
    await expect(safety.apply(token, write("a.md", "y", await hash("x")))).rejects.toThrow(/ownership changed/);
    await host.vaultRegistry.closeVault();
    await expect(safety.apply(next!, write("a.md", "y", await hash("x")))).rejects.toThrow(/ownership changed/);
    await expect(safety.claimOwner()).rejects.toThrow(/No vault open/);
  });
  it("a lease does not survive switching vaults", async () => {
    const { safety, token, host } = await open();
    await host.vaultRegistry.closeVault();
    await host.vaultRegistry.openVault("external://other");
    await expect(safety.storage(token, BINDING, { action: "load-operations" })).rejects.toThrow(/ownership changed/);
    const next = (await safety.claimOwner())!;
    expect(next).not.toBe(token);
    await expect(safety.storage(next, BINDING, { action: "load-operations" })).resolves.toEqual([]);
  });
});

describe("hash-guarded write", () => {
  it("creates a file, replaces a file whose hash matches, and writes missing parents first", async () => {
    const { safety, token, vault } = await open();
    const created = await safety.apply(token, write("Notes/Deep/New.md", "one", null));
    expect(created).toMatchObject({ status: "applied", hash: await hash("one") });
    expect(vault.text("Notes/Deep/New.md")).toBe("one");
    expect(vault.folders.has("Notes") && vault.folders.has("Notes/Deep")).toBe(true);
    const replaced = await safety.apply(token, write("Notes/Deep/New.md", "two", await hash("one")));
    expect(replaced.status).toBe("applied");
    expect(vault.text("Notes/Deep/New.md")).toBe("two");
  });
  it("rejects a stale expected hash and leaves the file untouched", async () => {
    const { safety, token, vault } = await open();
    vault.put("a.md", "edited on the phone");
    await expect(safety.apply(token, write("a.md", "from hub", await hash("what sync last saw")))).rejects.toThrow(/changed before sync application/);
    expect(vault.text("a.md")).toBe("edited on the phone");
    await expect(safety.apply(token, write("b.md", "from hub", await hash("expected a file")))).rejects.toThrow(/changed before sync application/);
    expect(vault.files.has("b.md")).toBe(false);
    vault.put("c.md", "exists");
    await expect(safety.apply(token, write("c.md", "from hub", null))).rejects.toThrow(/changed before sync application/);
    expect(vault.text("c.md")).toBe("exists");
  });
  it("rejects a file that changes after the guard passed but before the write (re-checked just before mutating)", async () => {
    const { safety, token, vault } = await open();
    vault.put("a.md", "v1");
    let stats = 0;
    vault.beforeStat = path => { if (path === "a.md" && ++stats === 2) vault.files.set("a.md", new TextEncoder().encode("typed meanwhile")); };
    await expect(safety.apply(token, write("a.md", "from hub", await hash("v1")))).rejects.toThrow(/changed while sync prepared recovery/);
    expect(vault.text("a.md")).toBe("typed meanwhile");
    expect(vault.calls.filter(call => call.startsWith("writeBinary a.md"))).toEqual([]);
  });
  it("refuses unsafe paths, links, files-as-folders, bad identities and oversized data", async () => {
    const { safety, token, vault } = await open();
    for (const path of ["../x.md", "a/../b.md", ".hidden.md", "a//b.md", "a\\b.md", "", "/abs.md", ".geode/themes/x/theme.css"]) await expect(safety.apply(token, write(path, "x", null))).rejects.toThrow(/Unsafe sync path/);
    vault.put("real/inside.md", "x"); vault.links.add("real");
    await expect(safety.apply(token, write("real/inside.md", "y", await hash("x")))).rejects.toThrow(/symbolic links/);
    vault.put("plain.md", "x");
    await expect(safety.apply(token, write("plain.md/child.md", "y", null))).rejects.toThrow(/not a directory/);
    await expect(safety.apply(token, { ...write("a.md", "x", null), operationId: "not-a-uuid" })).rejects.toThrow(/operation identity/);
    await expect(safety.apply(token, { operationId: uuid(), path: "a.md", expectedHash: null, kind: "write" })).rejects.toThrow(/bytes required/);
    await expect(safety.apply(token, { ...write("a.md", "x", null), kind: "rename" as never })).rejects.toThrow(/Invalid sync mutation/);
    await expect(safety.apply(token, { operationId: uuid(), path: "big.md", expectedHash: null, kind: "write", data: new ArrayBuffer(100 * 1024 * 1024 + 1) })).rejects.toThrow(/100 MiB/);
    expect(vault.files.has("a.md")).toBe(false);
  });
  it("won't replace a folder or a file whose content cannot be read right now", async () => {
    const { safety, token, vault } = await open();
    vault.folders.add("Folder");
    await expect(safety.apply(token, write("Folder", "x", "folder"))).rejects.toThrow(/cannot replace a folder/);
    vault.put("evicted.md", "x"); vault.evicted.add("evicted.md");
    await expect(safety.apply(token, write("evicted.md", "y", await hash("x")))).rejects.toThrow();
    expect(vault.text("evicted.md")).toBe("x");
  });
});

describe("trash and mkdir", () => {
  it("trashes a file whose hash matches, keeps the preimage in private recovery, and refuses a stale hash", async () => {
    const { safety, token, vault } = await open();
    vault.put("Doomed.md", "bye");
    await expect(safety.apply(token, { operationId: uuid(), path: "Doomed.md", expectedHash: await hash("edited"), kind: "trash" })).rejects.toThrow(/changed before/);
    expect(vault.text("Doomed.md")).toBe("bye");
    const operationId = uuid();
    const result = await safety.apply(token, { operationId, path: "Doomed.md", expectedHash: await hash("bye"), kind: "trash" });
    expect(result).toMatchObject({ status: "applied", hash: null });
    expect(vault.files.has("Doomed.md")).toBe(false);
    expect(vault.trashed).toEqual(["Doomed.md"]);
    const before = [...vault.privateFiles].find(([key]) => key.endsWith(`/recovery/${operationId}/before`));
    expect(new TextDecoder().decode(before![1])).toBe("bye");
  });
  it("trashes an empty folder but never a folder that has live descendants", async () => {
    const { safety, token, vault } = await open();
    vault.folders.add("Empty"); vault.put("Full/inner.md", "x");
    await expect(safety.apply(token, { operationId: uuid(), path: "Full", expectedHash: "folder", kind: "trash" })).rejects.toThrow(/live descendants/);
    expect(vault.files.has("Full/inner.md")).toBe(true);
    await expect(safety.apply(token, { operationId: uuid(), path: "Empty", expectedHash: "folder", kind: "trash" })).resolves.toMatchObject({ status: "applied" });
    expect(vault.folders.has("Empty")).toBe(false);
  });
  it("a folder that gains a child while sync prepares is not trashed", async () => {
    const { safety, token, vault } = await open();
    vault.folders.add("Race");
    let stats = 0;
    vault.beforeStat = path => { if (path === "Race" && ++stats === 2) vault.put("Race/new.md", "just typed"); };
    await expect(safety.apply(token, { operationId: uuid(), path: "Race", expectedHash: "folder", kind: "trash" })).rejects.toThrow(/live descendants|acquired|changed while/);
    expect(vault.text("Race/new.md")).toBe("just typed");
  });
  it("trash of a path that is already absent is a no-op success, mkdir creates parents", async () => {
    const { safety, token, vault } = await open();
    await expect(safety.apply(token, { operationId: uuid(), path: "Gone.md", expectedHash: null, kind: "trash" })).resolves.toMatchObject({ status: "applied", hash: null });
    expect(vault.trashed).toEqual([]);
    await expect(safety.apply(token, { operationId: uuid(), path: "A/B/C", expectedHash: null, kind: "mkdir" })).resolves.toMatchObject({ status: "applied", hash: "folder" });
    expect(vault.folders.has("A/B/C")).toBe(true);
    await expect(safety.apply(token, { operationId: uuid(), path: "A/B/C", expectedHash: null, kind: "mkdir" })).rejects.toThrow(/changed before/);
  });
});

describe("crash recovery inside a mutation (an operation is retried with the same identity)", () => {
  function crashing(point: string) {
    const vault = new FakeManagedVault();
    let armed = true;
    const ports = portsFor(vault);
    const safety = createMobileSyncSafety(ports, { checkpoint: name => { if (armed && name === point) { armed = false; throw new Error(`crash at ${name}`); } } });
    return { vault, safety, ports };
  }
  function portsFor(vault: FakeManagedVault): MobileSyncPorts {
    const p = vault.plugin;
    return {
      rootId: () => "managed://default",
      vault: {
        stat: path => p.stat!({ path }), readBinary: async path => base64ToBytes((await p.readBinary({ path })).base64).buffer as ArrayBuffer,
        writeBinary: async (path, data) => { await p.writeBinary!({ path, base64: bytesToBase64(new Uint8Array(data)) }); },
        mkdir: async path => { await p.mkdir({ path }); }, trash: async path => { await p.trash({ path }); },
      },
      privateStore: {
        write: async (path, data) => { await p.syncPrivateWrite!({ path, base64: bytesToBase64(data) }); },
        read: async path => { const r = await p.syncPrivateRead!({ path }); return r.found ? base64ToBytes(r.base64!) : null; },
        list: async path => (await p.syncPrivateList!({ path })).entries, remove: async (path, recursive) => { await p.syncPrivateRemove!({ path, recursive }); },
        availableBytes: async () => null,
      },
      config: { read: async () => null, write: async () => {} },
    };
  }

  it.each(["prepared", "staged"])("a crash %s the file is touched leaves it intact; the retry applies", async point => {
    const { vault, safety } = crashing(point);
    vault.put("a.md", "old");
    const token = (await safety.claimOwner())!;
    const input = write("a.md", "new", await hash("old"));
    await expect(safety.apply(token, input)).rejects.toThrow(/crash at/);
    expect(vault.text("a.md")).toBe("old");
    await expect(safety.apply(token, input)).resolves.toMatchObject({ status: "applied" });
    expect(vault.text("a.md")).toBe("new");
  });
  it.each(["committed", "acknowledged"])("a crash after the write (%s) is recognised on retry as already applied, never applied twice", async point => {
    const { vault, safety } = crashing(point);
    vault.put("a.md", "old");
    const token = (await safety.claimOwner())!;
    const input = write("a.md", "new", await hash("old"));
    await expect(safety.apply(token, input)).rejects.toThrow(/crash at/);
    expect(vault.text("a.md")).toBe("new");
    const writes = vault.calls.filter(call => call.startsWith("writeBinary a.md")).length;
    await expect(safety.apply(token, input)).resolves.toMatchObject({ status: "already-applied", hash: await hash("new") });
    expect(vault.calls.filter(call => call.startsWith("writeBinary a.md")).length).toBe(writes);
    await expect(safety.apply(token, input)).resolves.toMatchObject({ status: "already-applied" });
  });
  it("a crash after a trash is already-applied on retry, and the preimage was saved before the trash", async () => {
    const { vault, safety } = crashing("committed");
    vault.put("a.md", "bye");
    const token = (await safety.claimOwner())!;
    const input: GuardedMutation = { operationId: uuid(), path: "a.md", expectedHash: await hash("bye"), kind: "trash" };
    await expect(safety.apply(token, input)).rejects.toThrow(/crash at/);
    expect(vault.files.has("a.md")).toBe(false);
    await expect(safety.apply(token, input)).resolves.toMatchObject({ status: "already-applied", hash: null });
    expect(vault.trashed).toEqual(["a.md"]);
    expect([...vault.privateFiles.keys()].some(key => key.endsWith(`${input.operationId}/before`))).toBe(true);
  });
  it("mid-batch: operations committed before the crash stay applied; the rest apply on resume; nothing double-applies", async () => {
    const { vault, safety } = crashing("committed");
    vault.put("one.md", "1").put("two.md", "2").put("three.md", "3");
    const token = (await safety.claimOwner())!;
    const batch = [write("one.md", "1!", await hash("1")), write("two.md", "2!", await hash("2")), write("three.md", "3!", await hash("3"))];
    const outcomes: string[] = [];
    for (const op of batch) { try { outcomes.push((await safety.apply(token, op)).status); } catch { outcomes.push("crashed"); break; } }
    expect(outcomes).toEqual(["crashed"]);
    for (const op of batch) outcomes.push((await safety.apply(token, op)).status);
    expect(outcomes).toEqual(["crashed", "already-applied", "applied", "applied"]);
    expect([vault.text("one.md"), vault.text("two.md"), vault.text("three.md")]).toEqual(["1!", "2!", "3!"]);
  });
  it("reusing an operation id with different content is refused", async () => {
    const { vault, safety } = crashing("committed");
    vault.put("a.md", "old");
    const token = (await safety.claimOwner())!;
    const id = uuid();
    await expect(safety.apply(token, write("a.md", "new", await hash("old"), id))).rejects.toThrow(/crash/);
    await expect(safety.apply(token, write("a.md", "DIFFERENT", await hash("old"), id))).rejects.toThrow(/identity was reused/);
  });
  it("a file edited after the crash but before the retry is not overwritten", async () => {
    const { vault, safety } = crashing("prepared");
    vault.put("a.md", "old");
    const token = (await safety.claimOwner())!;
    const input = write("a.md", "new", await hash("old"));
    await expect(safety.apply(token, input)).rejects.toThrow(/crash/);
    vault.put("a.md", "the user typed this");
    await expect(safety.apply(token, input)).rejects.toThrow(/changed before sync application/);
    expect(vault.text("a.md")).toBe("the user typed this");
  });
  it("a native write failure leaves the file and the receipt retryable", async () => {
    const { vault, safety } = crashing("never");
    vault.put("a.md", "old");
    const token = (await safety.claimOwner())!;
    const input = write("a.md", "new", await hash("old"));
    vault.beforeWrite = () => { vault.beforeWrite = undefined; throw Object.assign(new Error("disk full"), { code: "IO_FAILURE" }); };
    await expect(safety.apply(token, input)).rejects.toThrow(/disk full/);
    expect(vault.text("a.md")).toBe("old");
    await expect(safety.apply(token, input)).resolves.toMatchObject({ status: "applied" });
  });
});

describe("editor guard (onPrepare / onRelease)", () => {
  it("prepares before the write and releases after it, with one token, and a refusal blocks the write", async () => {
    const { safety, token, vault } = await open();
    const order: string[] = [];
    safety.onPrepare(async (guard, path) => { order.push(`prepare ${path} ${vault.text(path)}`); return null; });
    safety.onRelease(async () => { order.push(`release ${vault.text("a.md")}`); });
    await safety.apply(token, write("a.md", "new", null));
    expect(order).toEqual(["prepare a.md null", "release new"]);

    const stop = safety.onPrepare(async () => "Unsaved editor changes block incoming sync");
    await expect(safety.apply(token, write("b.md", "x", null))).rejects.toThrow(/Unsaved editor changes/);
    expect(vault.files.has("b.md")).toBe(false);
    expect(order.at(-1)).toBe("release new");
    stop();
    await expect(safety.apply(token, write("b.md", "x", null))).resolves.toMatchObject({ status: "applied" });
  });
  it("a failing release surfaces as a retryable failure even though the file was written; a failed apply still releases", async () => {
    const { safety, token, vault } = await open();
    const release = vi.fn(async () => { throw new Error("refresh timed out"); });
    safety.onRelease(release);
    await expect(safety.apply(token, write("a.md", "x", null))).rejects.toThrow(/Editor refresh incomplete/);
    expect(vault.text("a.md")).toBe("x");
    await expect(safety.apply(token, write("b.md", "x", "e3b0"))).rejects.toThrow(/changed before/);
    expect(release).toHaveBeenCalledTimes(2);
  });
  it("applies are serialised", async () => {
    const { safety, token } = await open();
    let active = 0, peak = 0;
    safety.onPrepare(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); return null; });
    safety.onRelease(async () => { active--; });
    await Promise.all(["a", "b", "c"].map(name => safety.apply(token, write(`${name}.md`, name, null))));
    expect(peak).toBe(1);
  });
});

describe("sync-private storage", () => {
  async function storage(safety: SyncSafetyService, token: string, request: Parameters<SyncSafetyService["storage"]>[2], binding = BINDING) { return safety.storage(token, binding, request); }

  it("stages frozen bytes idempotently, refuses different bytes for the same key, and reads them back", async () => {
    const { safety, token } = await open();
    const key = uuid();
    await storage(safety, token, { action: "stage", key, data: bytes("frozen") });
    await storage(safety, token, { action: "stage", key, data: bytes("frozen") });
    await expect(storage(safety, token, { action: "stage", key, data: bytes("different") })).rejects.toThrow(/differ from retry content/);
    expect(new TextDecoder().decode(await storage(safety, token, { action: "read-stage", key }) as ArrayBuffer)).toBe("frozen");
    await expect(storage(safety, token, { action: "read-stage", key: uuid() })).rejects.toThrow(/missing/);
  });
  it("validates keys and bindings", async () => {
    const { safety, token } = await open();
    await expect(storage(safety, token, { action: "stage", key: "../escape", data: bytes("x") })).rejects.toThrow(/operation identity/);
    await expect(storage(safety, token, { action: "stage", key: uuid(), data: bytes("x") }, "not-a-binding")).rejects.toThrow(/binding/);
    await expect(storage(safety, token, { action: "stage", key: uuid(), data: bytes("x") }, "../".padEnd(64, "a"))).rejects.toThrow(/binding/);
    await expect(storage(safety, token, { action: "bogus" } as never)).rejects.toThrow(/Invalid sync storage request/);
    await expect(storage(safety, token, { action: "gc", retain: [1] } as never)).rejects.toThrow(/Invalid sync storage request/);
  });
  it("refuses to stage when the disk cannot hold the bytes twice plus headroom", async () => {
    const { safety, token, vault } = await open();
    vault.availableBytes = 7 * 1024 * 1024;
    await expect(storage(safety, token, { action: "stage", key: uuid(), data: new ArrayBuffer(1024 * 1024) })).resolves.toBeDefined();
    await expect(storage(safety, token, { action: "stage", key: uuid(), data: new ArrayBuffer(2 * 1024 * 1024) })).rejects.toThrow(/Insufficient disk space/);
  });
  it("journals operations, reloads them in order, and releases blob and journal", async () => {
    const { safety, token } = await open();
    const [a, b] = [uuid(), uuid()].sort();
    await storage(safety, token, { action: "save-operation", key: b, value: { phase: "prepared", id: "b" } });
    await storage(safety, token, { action: "save-operation", key: a, value: { phase: "prepared", id: "a" } });
    await storage(safety, token, { action: "stage", key: a, data: bytes("x") });
    expect(await storage(safety, token, { action: "load-operations" })).toEqual([{ phase: "prepared", id: "a" }, { phase: "prepared", id: "b" }]);
    await storage(safety, token, { action: "release", key: a });
    await storage(safety, token, { action: "release", key: a });
    expect(await storage(safety, token, { action: "load-operations" })).toEqual([{ phase: "prepared", id: "b" }]);
    await expect(storage(safety, token, { action: "read-stage", key: a })).rejects.toThrow();
  });
  it("gc keeps prepared operations, retained ids and unparseable journals, and removes the rest", async () => {
    const { safety, token, vault } = await open();
    const [prepared, retained, done, broken] = [uuid(), uuid(), uuid(), uuid()];
    const payload = uuid();
    await storage(safety, token, { action: "save-operation", key: prepared, value: { phase: "prepared", payload: { key: payload } } });
    await storage(safety, token, { action: "stage", key: payload, data: bytes("blob") });
    await storage(safety, token, { action: "save-operation", key: retained, value: { phase: "committed" } });
    await storage(safety, token, { action: "save-operation", key: done, value: { phase: "committed" } });
    await storage(safety, token, { action: "stage", key: done, data: bytes("blob") });
    const dir = [...vault.privateFiles.keys()].find(key => key.endsWith(`${done}.json`))!.replace(`${done}.json`, "");
    vault.privateFiles.set(`${dir}${broken}.json`, new TextEncoder().encode("{not json"));
    vault.privateFiles.set(`${dir}${uuid()}.json.tmp`, new Uint8Array(1));
    const result = await storage(safety, token, { action: "gc", retain: [retained] }) as { removed: number };
    expect(result.removed).toBe(3);
    expect([...vault.privateFiles.keys()].filter(key => key.startsWith(dir) && key.endsWith(".json")).length).toBe(3);
    expect([...vault.privateFiles.keys()].some(key => key.endsWith(".tmp"))).toBe(false);
    expect(vault.privateFiles.has(`${dir}${payload}.blob`)).toBe(true);
    expect(vault.privateFiles.has(`${dir}${done}.blob`)).toBe(false);
    expect(vault.privateFiles.has(`${dir}${broken}.json`)).toBe(true);
  });
  it("sweeps stale bindings but never one holding a prepared journal unless forced", async () => {
    const { safety, token } = await open();
    const [live, stale, busy] = ["1", "2", "3"].map(digit => digit.repeat(64));
    await storage(safety, token, { action: "save-operation", key: uuid(), value: { phase: "committed" } }, live);
    await storage(safety, token, { action: "save-operation", key: uuid(), value: { phase: "committed" } }, stale);
    await storage(safety, token, { action: "save-operation", key: uuid(), value: { phase: "prepared" } }, busy);
    expect(await storage(safety, token, { action: "sweep", keep: [live], force: false })).toEqual({ removed: [stale], skipped: [busy] });
    expect(await storage(safety, token, { action: "sweep", keep: [], force: true })).toEqual({ removed: [live, busy], skipped: [] });
    expect(await storage(safety, token, { action: "load-operations" }, live)).toEqual([]);
  });
  it("bindings are isolated from each other and from other vaults", async () => {
    const { safety, token, host } = await open();
    const key = uuid();
    await storage(safety, token, { action: "save-operation", key, value: { id: 1 } }, "1".repeat(64));
    expect(await storage(safety, token, { action: "load-operations" }, "2".repeat(64))).toEqual([]);
    await host.vaultRegistry.closeVault();
    await host.vaultRegistry.openVault("external://other");
    const next = (await safety.claimOwner())!;
    expect(await storage(safety, next, { action: "load-operations" }, "1".repeat(64))).toEqual([]);
  });
});

describe("private storage is outside the synced vault tree", () => {
  it("never appears in a scan, a listing or an existence check, and the vault never contains the bytes", async () => {
    const { safety, token, vault, host } = await open();
    vault.put("Note.md", "visible");
    await safety.storage(token, BINDING, { action: "stage", key: uuid(), data: bytes("PRIVATE-FROZEN-BYTES") });
    await safety.storage(token, BINDING, { action: "save-operation", key: uuid(), value: { secret: "PRIVATE-JOURNAL" } });
    vault.put("Other.md", "x");
    await safety.apply(token, write("Other.md", "y", await hash("x")));
    expect(vault.privateFiles.size).toBeGreaterThan(2);
    const scan = await host.vaultFiles.reconcileScan();
    expect(scan.entries.map(entry => entry.path)).toEqual(["Note.md", "Other.md"]);
    expect((await host.vaultFiles.list()).map(entry => entry.path)).toEqual(["Note.md", "Other.md"]);
    for (const key of vault.privateFiles.keys()) { expect(await host.vaultFiles.exists(key.split("/")[0]).catch(() => false)).toBe(false); }
    const everythingInVault = [...vault.files.values()].map(value => new TextDecoder().decode(value)).join("\n");
    expect(everythingInVault).not.toContain("PRIVATE");
    expect(vault.privateDump()).toContain("PRIVATE-FROZEN-BYTES");
  });
  it("native private paths must be relative and inside the sandbox", async () => {
    const vault = new FakeManagedVault();
    await expect(vault.plugin.syncPrivateWrite!({ path: "../escape", base64: "" })).rejects.toMatchObject({ code: "INVALID_PATH" });
  });
});

describe("iCloud placeholders are blocked, never deleted", () => {
  const entry = (path: string) => ({ path, isFolder: false, mtime: 1, ctime: 1, size: 1 });
  it("reports a lone .name.icloud stub as blocked at the real path and keeps it out of the entries", () => {
    const split = splitICloudPlaceholders([entry("A.md"), entry(".Away.md.icloud"), entry("Deep/.Gone.pdf.icloud"), entry(".Local.md.icloud"), entry("Local.md")]);
    expect(split.entries.map(item => item.path)).toEqual(["A.md", "Local.md"]);
    expect(split.blocked).toEqual([{ path: "Away.md", reason: "icloud-not-downloaded" }, { path: "Deep/Gone.pdf", reason: "icloud-not-downloaded" }]);
  });
  it("reconcileScan carries blocked, and omits the field when nothing is blocked", async () => {
    const { vault, host } = await open();
    vault.put("A.md", "a");
    expect(await host.vaultFiles.reconcileScan()).toEqual({ status: "complete", entries: expect.any(Array) });
    expect("blocked" in await host.vaultFiles.reconcileScan()).toBe(false);
    vault.put(".Away.md.icloud", "stub");
    const scan = await host.vaultFiles.reconcileScan();
    expect(scan.blocked).toEqual([{ path: "Away.md", reason: "icloud-not-downloaded" }]);
    expect(scan.entries.map(item => item.path)).toEqual(["A.md"]);
  });
  it("a file evicted mid-run, or too large for the bridge, reads as SyncBlockedError rather than an error in the file", async () => {
    const { vault, host } = await open();
    vault.put("Evicted.md", "x"); vault.evicted.add("Evicted.md");
    vault.put("Big.bin", "x"); vault.oversize.add("Big.bin");
    await expect(host.vaultFiles.readBinary("Evicted.md")).rejects.toBeInstanceOf(SyncBlockedError);
    await expect(host.vaultFiles.readBinary("Big.bin")).rejects.toMatchObject({ syncBlockedReason: "too-large-for-mobile" });
    vault.put("Fine.md", "ok");
    expect(new TextDecoder().decode(await host.vaultFiles.readBinary("Fine.md"))).toBe("ok");
  });
});

describe("Keychain-backed host.secrets.app", () => {
  it("round-trips through the native Keychain only, and plugin secrets stay unavailable", async () => {
    const vault = new FakeManagedVault();
    const host = createCapacitorHost(vault.plugin, createBrowserHost(createBrowserHostState()));
    expect(host.secrets.app).toBeDefined();
    expect(host.secrets.appAvailable).toBe(true);
    expect(host.secrets.available).toBe(false);
    await host.secrets.app!.set("hub-token/hub.example", "s3cret");
    expect(vault.keychain.get("hub-token/hub.example")).toBe("s3cret");
    expect(await host.secrets.app!.get("hub-token/hub.example")).toBe("s3cret");
    expect(await host.secrets.app!.get("missing")).toBeNull();
    await host.secrets.app!.remove("hub-token/hub.example");
    expect(await host.secrets.app!.get("hub-token/hub.example")).toBeNull();
    await expect(host.secrets.fromCapability("some-plugin").set("k", "v")).rejects.toThrow();
  });
  it("is absent on a native build without Keychain methods, so the token is refused rather than stored elsewhere", () => {
    const vault = new FakeManagedVault();
    const old = { ...vault.plugin } as Record<string, unknown>; delete old.appSecretSet;
    const host = createCapacitorHost(old as never, createBrowserHost(createBrowserHostState()));
    expect(host.secrets.app).toBeUndefined();
    expect(host.secrets.appAvailable).toBeUndefined();
  });
});
