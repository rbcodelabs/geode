import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { dispatchHubRequest } from "../../src/main/hub-sync-ipc";
import { HubError, HubStoreManager, classifySshFailure, validateHubTarget } from "../../src/sync-node/app-hub";
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
    [{ kind: "ssh", host: "-oProxyCommand=evil", path: "/x" }], [{ kind: "ssh", host: "a b", path: "/x" }], [{ kind: "ssh", host: "", path: "/x" }], [{ kind: "ssh", path: "/x" }],
    [{ kind: "ftp", path: "/x" }],
  ])("refuses %j", value => { expect(() => validateHubTarget(value)).toThrow(HubError); });
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

  it("surfaces main-process failures as HubSyncError with code and hint", async () => {
    const { provider } = mk(dir("h"));
    await provider.setConfig({ schema: 1, target: { kind: "fs", path: "relative" }, create: false });
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
