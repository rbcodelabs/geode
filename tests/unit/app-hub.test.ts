import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dispatchHubRequest } from "../../src/main/hub-sync-ipc";
import { HubError, HubStoreManager, classifySshFailure, inspectFsHub, validateHubTarget } from "../../src/sync-node/app-hub";
import { spawnSshStore } from "../../src/sync-node/rpc-store";
import { SyncStoreError } from "../../src/sync-node/store-errors";
import type { AppendOnlySyncProvider } from "../../src/sync-core/history-types";
import { HubSyncError, HubSyncProvider } from "../../src/renderer/sync/hub-provider";
import { inProcessBridge, rmrf, tmpDir } from "../helpers/app-hub-harness";
import type { HubRequest } from "../../src/shared/hub-sync";

const dirs: string[] = [];
const dir = (prefix: string) => { const d = tmpDir(prefix); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmrf(d); });
const never = new AbortController().signal;
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const sha = (data: ArrayBuffer) => createHash("sha256").update(new Uint8Array(data)).digest("hex");

describe("validateHubTarget", () => {
  it("accepts an absolute folder and a safe ssh host", () => {
    expect(validateHubTarget({ kind: "fs", path: "/srv/hub/../hub" })).toEqual({ kind: "fs", path: "/srv/hub" });
    expect(validateHubTarget({ kind: "ssh", host: "geode-hub", path: "/home/rick/geode-hub/Personal" })).toEqual({ kind: "ssh", host: "geode-hub", path: "/home/rick/geode-hub/Personal" });
    expect(validateHubTarget({ kind: "ssh", host: "rick@10.0.0.4", path: "hub" })).toMatchObject({ kind: "ssh", host: "rick@10.0.0.4" });
  });
  it.each([
    [null], [{}], [{ kind: "fs" }], [{ kind: "fs", path: "relative/hub" }], [{ kind: "fs", path: "/a\0b" }], [{ kind: "fs", path: "  " }],
    [{ kind: "ssh", host: "", path: "/x" }], [{ kind: "ssh", path: "/x" }], [{ kind: "ftp", path: "/x" }],
    [{ kind: "fs", path: "/a\nb" }], [{ kind: "ssh", host: "h", path: "/a\nb" }], [{ kind: "ssh", host: "h", path: "/a/../b" }],
  ])("refuses %j", value => { expect(() => validateHubTarget(value)).toThrow(HubError); });

  // The host is user-controlled and ends up in an ssh argv: nothing that ssh or a shell could read as more than a name.
  it.each([
    "-oProxyCommand=evil", "-F/x", "-F", "--", "-", "user@-oFoo", "-oFoo@host", "a b", "a\tb", "a\nb", "host\n", "host;id", "host&&id", "host|id", "host`id`", "host$(id)", "$HOST",
    "ho'st", 'ho"st', "ho\\st", "host:22", "host/path", "host#x", "host!", "host*", "host?", "[::1]", "user@", "@host", "user@@host", " host", "host ", "h\u0000st", "hôst", ".", "a..".repeat(100),
  ])("refuses the hostile ssh host %j", host => {
    expect(() => validateHubTarget({ kind: "ssh", host, path: "/x" })).toThrow(HubError);
  });

  it("never spawns ssh for a hostile host, from the IPC dispatcher or from spawnSshStore", async () => {
    const bin = dir("ssh-marker"), marker = join(bin, "spawned");
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\ntouch "${marker}"\n`); chmodSync(join(bin, "ssh"), 0o755);
    const original = process.env.PATH; process.env.PATH = `${bin}:${original}`;
    try {
      for (const host of ["-oProxyCommand=touch /tmp/pwned", "-F/x", "user@-oFoo", "a b"]) {
        const response = await dispatchHubRequest(new HubStoreManager(), "w", { method: "discover", target: { kind: "ssh", host, path: "/h" } }, never);
        expect(response).toMatchObject({ ok: false, error: { code: "invalid-target" } });
        expect(() => spawnSshStore({ host, storePath: "/h" })).toThrow();
      }
      expect(() => spawnSshStore({ host: "ok", storePath: "/h\nrm -rf /" })).toThrow();
      expect(existsSync(marker)).toBe(false);
    } finally { process.env.PATH = original; }
  });
});

describe("inspectFsHub (Test connection / create pre-check; nothing is created)", () => {
  it("an existing readable hub is reported as a read-only check", async () => {
    const hub = dir("exists");
    expect(await inspectFsHub(hub, false)).toMatchObject({ exists: true, detail: expect.stringContaining("write access was not checked") });
    expect(await inspectFsHub(hub, true)).toMatchObject({ exists: true, detail: expect.stringContaining("writable") });
  });
  it("a missing folder under a writable ancestor is creatable, and is not created", async () => {
    const root = dir("root"), hub = join(root, "a", "b", "hub");
    expect(await inspectFsHub(hub, true)).toMatchObject({ exists: false, detail: expect.stringContaining("can be created") });
    expect(existsSync(join(root, "a"))).toBe(false);
    expect((await inspectFsHub(hub, false)).detail).toContain("does not exist yet");
  });
  it.skipIf(process.getuid?.() === 0)("an unwritable ancestor is reported as 'cannot create', naming the typed path", async () => {
    const root = dir("ro"); chmodSync(root, 0o500);
    try { await expect(inspectFsHub(join(root, "hub"), true)).rejects.toMatchObject({ message: expect.stringMatching(/Cannot create .*hub: no write permission in/) }); }
    finally { chmodSync(root, 0o700); }
    await expect(inspectFsHub("/geode-nonexistent-root/hub", true)).rejects.toMatchObject({ message: expect.stringContaining("/geode-nonexistent-root/hub") });
  });
  it("a file in the path is named as such, without internal blobs/ paths", async () => {
    const root = dir("file"); writeFileSync(join(root, "afile"), "x");
    for (const hub of [join(root, "afile"), join(root, "afile", "hub"), join(root, "afile", "x", "hub")]) {
      const error = await inspectFsHub(hub, true).catch(e => e);
      expect(error).toBeInstanceOf(HubError); expect(error.message).toContain(root); expect(error.message).not.toMatch(/blobs|records/);
    }
    // And through the real create path (the errno from mkdir is translated, not leaked).
    const manager = new HubStoreManager();
    const failure = await manager.createVault({ kind: "fs", path: join(root, "afile", "hub") }, { name: "x", operationId: "o" }).catch(e => e);
    expect(failure.message).toContain(join(root, "afile", "hub")); expect(failure.message).not.toMatch(/blobs|records/);
  });
  it("Test connection through the dispatcher reports reachability plus the create check", async () => {
    const root = dir("probe"), hub = join(root, "hub"), manager = new HubStoreManager();
    const response = await dispatchHubRequest(manager, "w", { method: "probe", target: { kind: "fs", path: hub }, create: true }, never);
    expect(response).toMatchObject({ ok: true, value: { vaults: [], detail: expect.stringContaining("can be created") } });
    expect(existsSync(hub)).toBe(false);
  });
});

describe("a folder hub that never answers cannot wedge the caller", () => {
  const hung = (onClose?: () => void) => ({
    id: "x", name: "x", protocol: "append-only-history-v1", capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
    discover: () => new Promise(() => {}), createVault: () => new Promise(() => {}), open: () => new Promise(() => {}),
    close: async () => { onClose?.(); },
  } as unknown as AppendOnlySyncProvider & { close(): Promise<void> });
  it.each(["discover", "createVault"] as const)("%s times out with a legible error even though the store ignores its signal", async method => {
    let closed = false;
    const manager = new HubStoreManager({ connectTimeoutMs: 60, fsProvider: () => hung(() => { closed = true; }) });
    const root = dir("hang"), target = { kind: "fs" as const, path: join(root, "hub") };
    const started = Date.now();
    const call = method === "discover" ? manager.discover(target) : manager.createVault(target, { name: "n", operationId: "o" });
    await expect(call).rejects.toMatchObject({ code: "timeout", message: expect.stringContaining(join(root, "hub")) });
    expect(Date.now() - started).toBeLessThan(2000); expect(closed).toBe(true);
  });
});

describe("classifySshFailure turns ssh's words into a status a person can act on", () => {
  it.each([
    ["rick@geode-hub: Permission denied (publickey).", "ssh-auth", /authentication failed/],
    ["Received disconnect: Too many authentication failures", "ssh-auth", /authentication/],
    ["Host key verification failed.", "ssh-host-key", /host key/],
    ["ssh: Could not resolve hostname geode-hub: nodename nor servname provided", "ssh-unreachable", /could not resolve/],
    ["ssh: connect to host 10.0.0.9 port 22: Connection refused", "ssh-unreachable", /could not reach/],
    ["ssh: connect to host 10.0.0.9 port 22: Operation timed out", "ssh-unreachable", /could not reach/],
    ["bash: geode-wiki: command not found", "ssh-no-geode-wiki", /not installed/],
  ])("%s", (stderr, code, message) => {
    const result = classifySshFailure(stderr, "geode-hub");
    expect(result?.code).toBe(code); expect(result?.message).toMatch(message); expect(result?.hint).toBeTruthy();
  });
  it("says nothing about stderr it does not understand", () => { expect(classifySshFailure("", "h")).toBeNull(); expect(classifySshFailure("random noise", "h")).toBeNull(); });
});

describe("HubStoreManager over a directory hub", () => {
  it("creates a vault, then another window discovers and drives a full session through the IPC dispatcher", async () => {
    const hub = dir("hub"), manager = new HubStoreManager();
    const target = { kind: "fs" as const, path: hub };
    const call = async <T,>(request: HubRequest, owner = "w1"): Promise<T> => { const response = await dispatchHubRequest(manager, owner, request, never); if (!response.ok) throw Object.assign(new Error(response.error.message), { info: response.error }); return response.value as T; };

    expect(await call<unknown[]>({ method: "discover", target })).toEqual([]);
    const descriptor = await call<any>({ method: "createVault", target, input: { name: "Hub", operationId: "op-1" } });
    expect(await call<any[]>({ method: "discover", target })).toEqual([descriptor]);

    const opened = await call<any>({ method: "open", target, binding: descriptor, deviceId: "dev-a" });
    expect(opened.sessionId).toBeTruthy();
    const data = bytes("hello hub");
    const ref = await call<any>({ method: "putBlob", sessionId: opened.sessionId, input: { operationId: "b1", sha256: sha(data), size: data.byteLength, data } });
    expect(ref).toMatchObject({ sha256: sha(data), size: data.byteLength });
    expect(new TextDecoder().decode(await call<ArrayBuffer>({ method: "readBlob", sessionId: opened.sessionId, ref }))).toBe("hello hub");
    await call({ method: "appendRecord", sessionId: opened.sessionId, record: { schema: 1, vaultId: descriptor.vaultId, recordId: "r1", operationId: "o1", deviceId: "dev-a", entityId: "e1", namespace: "content", parents: [], kind: "file", deleted: false, location: { parentId: null, name: "a.md" }, blob: ref } } as never);
    const scan = await call<any>({ method: "scan", sessionId: opened.sessionId, cursor: undefined });
    expect(scan.status).toBe("complete"); expect(scan.records).toHaveLength(1);

    // Another window cannot use, or close, this window's session.
    await expect(call({ method: "scan", sessionId: opened.sessionId, cursor: undefined }, "w2")).rejects.toMatchObject({ info: { code: "no-session" } });
    await call({ method: "close", sessionId: opened.sessionId }, "w2");
    expect(manager.openSessions).toBe(1);
    await manager.closeOwner("w1");
    expect(manager.openSessions).toBe(0);
    await expect(call({ method: "scan", sessionId: opened.sessionId, cursor: undefined })).rejects.toMatchObject({ info: { code: "no-session" } });
  });

  it("returns failures as serialisable data with the store's own code", async () => {
    const hub = dir("hub-err"), manager = new HubStoreManager();
    const target = { kind: "fs" as const, path: hub };
    const response = await dispatchHubRequest(manager, "w1", { method: "open", target, binding: { schema: 1, protocol: "append-only-history-v1", vaultId: "11111111-1111-4111-8111-111111111111", rootId: "r", descriptorId: "d", name: "x" }, deviceId: "d" }, never);
    expect(response).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    expect(await dispatchHubRequest(manager, "w1", { method: "discover", target: { kind: "fs", path: "relative" } }, never)).toMatchObject({ ok: false, error: { code: "invalid-target" } });
    expect(await dispatchHubRequest(manager, "w1", { method: "nope" } as never, never)).toMatchObject({ ok: false, error: { code: "invalid-request" } });
  });

  it("an ssh failure reads as what ssh said, not as 'unavailable'", async () => {
    const manager = new HubStoreManager({
      sshProvider: (_target, onStderr) => ({
        id: "x", name: "x", protocol: "append-only-history-v1", capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
        discover: async () => { onStderr("rick@hub: Permission denied (publickey)."); throw new SyncStoreError("unavailable", "Store connection lost"); },
        createVault: async () => { throw new Error("unused"); }, open: async () => { throw new Error("unused"); },
      } as AppendOnlySyncProvider),
    });
    await expect(manager.discover({ kind: "ssh", host: "geode-hub", path: "/h" })).rejects.toMatchObject({ code: "ssh-auth", message: expect.stringContaining("authentication failed") });
  });

  it("a wedged connection becomes a timeout, and the provider is released", async () => {
    let closed = false;
    const manager = new HubStoreManager({
      connectTimeoutMs: 40,
      sshProvider: () => ({
        id: "x", name: "x", protocol: "append-only-history-v1", capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
        discover: (signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new SyncStoreError("aborted", "Operation aborted")))),
        createVault: async () => { throw new Error("unused"); }, open: async () => { throw new Error("unused"); },
        close: async () => { closed = true; },
      } as AppendOnlySyncProvider & { close(): Promise<void> }),
    });
    await expect(manager.discover({ kind: "ssh", host: "geode-hub", path: "/h" })).rejects.toMatchObject({ code: "timeout" });
    expect(closed).toBe(true);
  });

  it("a caller abort cancels the call", async () => {
    const manager = new HubStoreManager({
      sshProvider: () => ({
        id: "x", name: "x", protocol: "append-only-history-v1", capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
        discover: (signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new SyncStoreError("aborted", "Operation aborted")))),
        createVault: async () => { throw new Error("unused"); }, open: async () => { throw new Error("unused"); },
      } as AppendOnlySyncProvider),
    });
    const abort = new AbortController(), pending = manager.discover({ kind: "ssh", host: "h", path: "/h" }, abort.signal);
    abort.abort();
    await expect(pending).rejects.toBeInstanceOf(HubError);
  });
});

describe("HubSyncProvider", () => {
  const mk = (hub: string, store: { data?: unknown } = {}) => {
    const manager = new HubStoreManager(), bridge = inProcessBridge(manager);
    const state = new Map<string, unknown>();
    const provider = new HubSyncProvider(bridge, { read: async (k: string) => (state.get(k) ?? null) as never, write: async (k, v) => { state.set(k, structuredClone(v)); }, remove: async k => { state.delete(k); } }, () => "/vault/a");
    return { manager, bridge, provider, state };
  };

  it("keeps its configuration per vault, outside the vault", async () => {
    const { provider, state } = mk(dir("h"));
    expect(await provider.getConfig()).toBeNull();
    await provider.setConfig({ schema: 1, target: { kind: "ssh", host: " geode-hub ", path: " /home/rick/hub " }, create: true });
    expect(await provider.getConfig()).toEqual({ schema: 1, target: { kind: "ssh", host: "geode-hub", path: "/home/rick/hub" }, create: true });
    expect([...state.keys()]).toEqual(["sync-hub/config//vault/a"]);
    await provider.clearConfig(); expect(await provider.getConfig()).toBeNull();
  });

  it("refuses hostile or malformed settings with a clear message and saves nothing", async () => {
    const { provider, state } = mk(dir("h"));
    for (const target of [{ kind: "ssh" as const, host: "-oProxyCommand=evil", path: "/h" }, { kind: "ssh" as const, host: "a b", path: "/h" }, { kind: "ssh" as const, host: "h", path: "/h\n/x" }, { kind: "fs" as const, path: "relative" }, { kind: "fs" as const, path: "" }]) {
      const error = await provider.setConfig({ schema: 1, target, create: false }).catch(e => e);
      expect(error).toBeInstanceOf(HubSyncError); expect(error.code).toBe("invalid-target"); expect(error.message).toMatch(/valid ssh host|absolute|control character|Enter the hub/);
    }
    expect(state.size).toBe(0);
  });

  it("surfaces main-process failures as HubSyncError with code and hint", async () => {
    const { provider, state } = mk(dir("h"));
    state.set("sync-hub/config//vault/a", { schema: 1, target: { kind: "fs", path: "relative" }, create: false }); // as if edited on disk: main re-validates
    const error = await provider.discover(never).catch(e => e);
    expect(error).toBeInstanceOf(HubSyncError); expect(error.code).toBe("invalid-target");
  });

  it("rejects immediately on an already-aborted signal, and tells main to stop on a later abort", async () => {
    const { provider, bridge } = mk(dir("h"));
    await provider.setConfig({ schema: 1, target: { kind: "fs", path: dir("store") }, create: false });
    const aborted = new AbortController(); aborted.abort();
    await expect(provider.discover(aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(bridge.requests).toEqual([]);
  });

  it("offers batching and concurrency hints exactly as the store does", async () => {
    const hub = dir("store"), { provider } = mk(dir("h"));
    await provider.setConfig({ schema: 1, target: { kind: "fs", path: hub }, create: true });
    const descriptor = await provider.createVault({ name: "Hub", operationId: "op" }, never);
    const session = await provider.open({ binding: descriptor, deviceId: "d" }, never);
    expect(session.uploadConcurrency ?? 1).toBeGreaterThanOrEqual(1);
    await session.close();
  });
});
