import { describe, expect, it } from "vitest";
import { dispatchHubRequest, registerHubSyncIpc } from "../../src/main/hub-sync-ipc";
import { dispatchIcloudCall, registerIcloudContainerIpc } from "../../src/main/icloud-container-ipc";
import { HubStoreManager } from "../../src/sync-node/app-hub";
import { HubSyncError, HubSyncProvider } from "../../src/renderer/sync/hub-provider";
import { ICLOUD_BRIDGE_METHODS, type IcloudContainerBridge } from "../../src/shared/icloud-container";
import type { HubRequest } from "../../src/shared/hub-sync";
import type { SyncPolicyView } from "../../src/shared/sync-policy";

const signal = new AbortController().signal;
const off: SyncPolicyView = { enabled: false };
const MESSAGE = /blocked by administrator policy: sync/;

/** A manager whose providers must never be created while a request is refused. */
function watchedManager() {
  const made: string[] = [];
  const manager = new HubStoreManager({
    fsProvider: (path) => { made.push(`fs:${path}`); throw new Error("provider must not be created"); },
    sshProvider: (target) => { made.push(`ssh:${target.host}`); throw new Error("provider must not be created"); },
  });
  return { manager, made };
}

const REQUESTS: HubRequest[] = [
  { method: "discover", target: { kind: "fs", path: "/srv/hub" } },
  { method: "probe", target: { kind: "ssh", host: "geode-hub", path: "/srv/hub" }, create: false },
  { method: "createVault", target: { kind: "fs", path: "/srv/hub" }, input: { name: "V", operationId: "op" } },
  { method: "open", target: { kind: "fs", path: "/srv/hub" }, binding: { vaultId: "v", name: "V" } as never, deviceId: "d" },
  { method: "scan", sessionId: "s", cursor: undefined },
  { method: "putBlob", sessionId: "s", input: { operationId: "o", sha256: "x", size: 0, data: new ArrayBuffer(0) } },
  { method: "readBlob", sessionId: "s", ref: {} as never },
  { method: "appendRecord", sessionId: "s", record: {} as never },
  { method: "appendRecords", sessionId: "s", records: [] },
];

describe("hub-sync refusals", () => {
  it.each(REQUESTS.map((r) => [r.method, r] as const))("sync disabled refuses %s with a policy-blocked error and creates nothing", async (_name, request) => {
    const { manager, made } = watchedManager();
    const response = await dispatchHubRequest(manager, "w", request, signal, off);
    expect(response).toMatchObject({ ok: false, error: { code: "policy-blocked", message: expect.stringMatching(MESSAGE) } });
    expect(made).toEqual([]);
  });

  it("close stays allowed so a session can end cleanly after the policy changes", async () => {
    const { manager } = watchedManager();
    expect(await dispatchHubRequest(manager, "w", { method: "close", sessionId: "unknown" }, signal, off)).toEqual({ ok: true, value: undefined });
  });

  it("a provider list without hub refuses hub-sync; one with hub does not", async () => {
    const { manager, made } = watchedManager();
    const refused = await dispatchHubRequest(manager, "w", REQUESTS[0]!, signal, { providers: ["icloud"] });
    expect(refused).toMatchObject({ ok: false, error: { code: "policy-blocked", message: expect.stringContaining('provider "hub"') } });
    expect(made).toEqual([]);
    // Allowed by policy: the request proceeds to the (watched) provider, which is the proof it was not blocked.
    const allowed = await dispatchHubRequest(manager, "w", REQUESTS[0]!, signal, { providers: ["hub"] });
    expect(made).toEqual(["fs:/srv/hub"]);
    expect(allowed).toMatchObject({ ok: false, error: { code: expect.not.stringMatching(/policy-blocked/) } });
  });

  it("a hubAllowlist refuses folder and ssh hubs in discover and probe before any provider exists", async () => {
    const { manager, made } = watchedManager();
    const policy = { hubAllowlist: ["https://hub.corp.example"] };
    for (const request of [REQUESTS[0]!, REQUESTS[1]!, REQUESTS[2]!, REQUESTS[3]!]) {
      expect(await dispatchHubRequest(manager, "w", request, signal, policy)).toMatchObject({ ok: false, error: { code: "policy-blocked", message: expect.stringMatching(MESSAGE) } });
    }
    expect(made).toEqual([]);
  });

  it("no policy: behaviour is unchanged (the request reaches the provider)", async () => {
    const { manager, made } = watchedManager();
    await dispatchHubRequest(manager, "w", REQUESTS[0]!, signal);
    await dispatchHubRequest(manager, "w", REQUESTS[0]!, signal, null);
    expect(made).toEqual(["fs:/srv/hub", "fs:/srv/hub"]);
  });

  it("a refused request on an open session closes that session, and never touches the store", async () => {
    const closed: string[] = [];
    const fake = {
      protocol: 1,
      discover: async () => [],
      open: async () => ({ scan: async () => ({ records: [] }), close: async () => { closed.push("session"); } }),
      close: async () => { closed.push("provider"); },
    };
    const manager = new HubStoreManager({ fsProvider: () => fake as never });
    const target = { kind: "fs" as const, path: "/srv/hub" };
    const opened = await dispatchHubRequest(manager, "w", { method: "open", target, binding: { vaultId: "v", name: "V" } as never, deviceId: "d" }, signal);
    expect(opened.ok).toBe(true);
    const sessionId = (opened as { ok: true; value: { sessionId: string } }).value.sessionId;
    expect(manager.openSessions).toBe(1);
    const refused = await dispatchHubRequest(manager, "w", { method: "scan", sessionId, cursor: undefined }, signal, off);
    expect(refused).toMatchObject({ ok: false, error: { code: "policy-blocked" } });
    expect(manager.openSessions).toBe(0);
    expect(closed).toEqual(["session", "provider"]);
  });

  it("registerHubSyncIpc evaluates the policy per call (kill switch then re-enable)", async () => {
    const handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
    const ipcMain = { handle: (c: string, fn: any) => void handlers.set(c, fn), on: () => {} };
    const { manager, made } = watchedManager();
    let policy: SyncPolicyView | null = null;
    registerHubSyncIpc(ipcMain as never, manager, () => policy);
    const event = { sender: { id: 1, once: () => {} } };
    const call = () => handlers.get("hub-sync")!(event, REQUESTS[0], "r1");
    expect(await call()).toMatchObject({ ok: false, error: { code: expect.not.stringMatching(/policy-blocked/) } });
    policy = off;
    expect(await call()).toMatchObject({ ok: false, error: { code: "policy-blocked" } });
    policy = { enabled: true };
    await call();
    expect(made).toEqual(["fs:/srv/hub", "fs:/srv/hub"]); // blocked call created nothing
  });
});

describe("iCloud container refusals", () => {
  function recordingBridge() {
    const calls: string[] = [];
    const bridge = Object.fromEntries(ICLOUD_BRIDGE_METHODS.map((m) => [m, async () => { calls.push(m); return "ok"; }])) as unknown as IcloudContainerBridge;
    return { bridge, calls };
  }

  it("sync disabled refuses every container method except local discardWrite cleanup, without touching the bridge", async () => {
    const { bridge, calls } = recordingBridge();
    for (const method of ICLOUD_BRIDGE_METHODS) {
      const response = await dispatchIcloudCall(bridge, method, [], signal, off);
      if (method === "discardWrite") expect(response).toEqual({ ok: true, value: "ok" });
      else expect(response).toMatchObject({ ok: false, error: { message: expect.stringMatching(MESSAGE) } });
    }
    expect(calls).toEqual(["discardWrite"]);
  });

  it("a provider list without icloud refuses it; with icloud (or no policy) it works", async () => {
    const { bridge, calls } = recordingBridge();
    expect(await dispatchIcloudCall(bridge, "listRoots", [], signal, { providers: ["hub"] })).toMatchObject({ ok: false, error: { message: expect.stringContaining('provider "icloud"') } });
    expect(await dispatchIcloudCall(bridge, "listRoots", [], signal, { providers: ["icloud"] })).toMatchObject({ ok: true });
    expect(await dispatchIcloudCall(bridge, "listRoots", [], signal)).toMatchObject({ ok: true });
    expect(calls).toEqual(["listRoots", "listRoots"]);
  });

  it("registerIcloudContainerIpc evaluates the policy per call", async () => {
    const handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
    const ipcMain = { handle: (c: string, fn: any) => void handlers.set(c, fn), on: () => {} };
    const { bridge, calls } = recordingBridge();
    let policy: SyncPolicyView | null = null;
    registerIcloudContainerIpc(ipcMain as never, () => ({ ...bridge, close: async () => {} }) as never, () => policy);
    const event = { sender: { id: 1, once: () => {} } };
    const call = () => handlers.get("icloud-container")!(event, "listRoots", [], "r");
    expect(await call()).toMatchObject({ ok: true });
    policy = off;
    expect(await call()).toMatchObject({ ok: false, error: { message: expect.stringMatching(MESSAGE) } });
    policy = null;
    expect(await call()).toMatchObject({ ok: true });
    expect(calls).toEqual(["listRoots", "listRoots"]);
  });
});

describe("renderer HubSyncProvider (advisory check, before anything is dialled)", () => {
  const device = () => { const state = new Map<string, unknown>(); return { read: async (k: string) => (state.get(k) ?? null) as never, write: async (k: string, v: unknown) => { state.set(k, v); }, remove: async (k: string) => { state.delete(k); } }; };

  it("refuses an https hub that is not allowlisted without constructing a WebSocket", async () => {
    let sockets = 0;
    const webSocket = (() => { sockets++; throw new Error("must not connect"); }) as never;
    const policy: SyncPolicyView = { hubAllowlist: ["https://hub.corp.example"] };
    const provider = new HubSyncProvider(undefined, device(), () => "/vault", { policy: async () => policy, http: { webSocket } });
    await provider.setConfig({ schema: 1, target: { kind: "http", url: "https://evil.example" }, create: true });
    const signal = new AbortController().signal;
    for (const action of [() => provider.probe(signal), () => provider.discover(signal), () => provider.createVault({ name: "V", operationId: "o" }, signal), () => provider.open({ binding: { vaultId: "v" } as never, deviceId: "d" }, signal)]) {
      const error = await action().then(() => null, (e) => e);
      expect(error).toBeInstanceOf(HubSyncError);
      expect((error as HubSyncError).code).toBe("policy-blocked");
      expect((error as HubSyncError).message).toMatch(MESSAGE);
    }
    expect(sockets).toBe(0);
  });

  it("the settings can still be saved (non-destructive); only using the hub is refused", async () => {
    const provider = new HubSyncProvider(undefined, device(), () => "/vault", { policy: async () => ({ enabled: false }) });
    await provider.setConfig({ schema: 1, target: { kind: "http", url: "https://evil.example" }, create: false });
    expect(await provider.getConfig()).toMatchObject({ target: { kind: "http", url: "https://evil.example/" } });
  });

  it("a policy getter that throws fails open", async () => {
    let sockets = 0;
    const webSocket = (() => { sockets++; throw new Error("reached the socket"); }) as never;
    const provider = new HubSyncProvider(undefined, device(), () => "/vault", { policy: async () => { throw new Error("ipc down"); }, http: { webSocket } });
    await provider.setConfig({ schema: 1, target: { kind: "http", url: "https://hub.corp.example" }, create: false });
    await provider.probe(new AbortController().signal).catch(() => {});
    expect(sockets).toBe(1);
  });
});
