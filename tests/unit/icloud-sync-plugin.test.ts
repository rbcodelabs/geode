import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchIcloudCall, registerIcloudContainerIpc, toFailure } from "../../src/main/icloud-container-ipc";
import { App } from "../../src/renderer/app";
import { IcloudSyncPlugin } from "../../src/renderer/internal-plugins/icloud-sync/icloud-sync-plugin";
import { createIpcIcloudBridge, IcloudBridgeError, type IcloudBridgeResponse, type IcloudContainerBridge } from "../../src/shared/icloud-container";
import { createContainerLocator, NodeIcloudContainer } from "../../src/sync-node/icloud-container";
import { FakeIcloudBridge } from "../helpers/fake-icloud-bridge";

const signal = () => new AbortController().signal;
const OPTS = { maxHashBytes: 1024 };

function fakeApp(vaultRoot = "/Users/me/Notes/My Vault") {
  const unregister = vi.fn(async () => {});
  const state = new Map<string, unknown>();
  let active: { id: string } | null = null;
  const app = {
    vault: { root: vaultRoot },
    sync: { register: vi.fn((_owner: string, _provider: unknown) => unregister), getActiveProvider: () => active },
    host: {
      deviceState: {
        read: async (key: string) => state.get(key) ?? null,
        write: async (key: string, value: unknown) => void state.set(key, value),
      },
    },
  };
  return { app, unregister, state, setActive: (id: string | null) => (active = id ? { id } : null) };
}

describe("IcloudSyncPlugin", () => {
  it("registers the iCloud provider (id icloud, conditional-mutation-v1) on load and unregisters on unload", () => {
    const { app, unregister } = fakeApp();
    const plugin = new IcloudSyncPlugin(app as any, new FakeIcloudBridge());
    plugin.load();
    expect(app.sync.register).toHaveBeenCalledTimes(1);
    const [owner, provider] = app.sync.register.mock.calls[0] as [string, { id: string; protocol: string }];
    expect(owner).toBe("icloud-sync");
    expect(provider).toMatchObject({ id: "icloud", protocol: "conditional-mutation-v1" });
    plugin.unload();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("does not probe the container at load (lazy availability)", () => {
    const { app } = fakeApp();
    const bridge = new FakeIcloudBridge();
    const spy = vi.spyOn(bridge, "availability");
    new IcloudSyncPlugin(app as any, bridge).load();
    expect(spy).not.toHaveBeenCalled();
  });

  it("describes an unavailable container with the bridge's explanation", async () => {
    const { app } = fakeApp();
    const bridge = new FakeIcloudBridge();
    bridge.availabilityState = { state: "unavailable", reason: "container-not-found", message: "Open Geode for iOS once." };
    expect(await new IcloudSyncPlugin(app as any, bridge).describeRemote()).toEqual({ state: "unavailable", message: "Open Geode for iOS once." });
  });

  it("describes the remote folder, its state and the marked folders, and persists the choice per vault in device state", async () => {
    const { app, state, setActive } = fakeApp("/Users/me/Notes/My Vault");
    const bridge = new FakeIcloudBridge();
    bridge.seedFile("From Other Device", ".geode-sync/marker.json", "{}");
    bridge.seedFile("Photos", "holiday.jpg", "x");
    const plugin = new IcloudSyncPlugin(app as any, bridge);
    expect(await plugin.describeRemote()).toEqual({ state: "ready", name: "My Vault", folder: "missing", existing: ["From Other Device"] });
    expect(await plugin.applyFolder("From Other Device")).toMatchObject({ ok: true, name: "From Other Device" });
    expect(state.get("plugin/icloud-sync/folders")).toEqual({ folders: { "/Users/me/Notes/My Vault": "From Other Device" } });
    expect(await plugin.describeRemote()).toMatchObject({ name: "From Other Device", folder: "marked" });
    expect(await plugin.applyFolder("Photos")).toMatchObject({ ok: false, reason: "not-a-geode-folder" });
    setActive("icloud");
    expect(await plugin.applyFolder("Another")).toMatchObject({ ok: false, reason: "active" });
  });
});

describe("App.syncIcloudSyncPlugin guards", () => {
  const sync = App.prototype.syncIcloudSyncPlugin;
  function appThis(over: { enabled: boolean; capable: boolean; bridge?: IcloudContainerBridge }) {
    const { app, unregister } = fakeApp();
    return {
      self: { ...app, icloudSyncPlugin: undefined as IcloudSyncPlugin | undefined, settings: { icloudSyncEnabled: over.enabled }, host: { ...app.host, capabilities: { icloudContainer: over.capable }, ...(over.bridge ? { icloudContainer: over.bridge } : {}) } },
      register: app.sync.register,
      unregister,
    };
  }

  it("is off by default: no plugin, no provider", () => {
    const t = appThis({ enabled: false, capable: true, bridge: new FakeIcloudBridge() });
    sync.call(t.self);
    expect(t.self.icloudSyncPlugin).toBeUndefined();
    expect(t.register).not.toHaveBeenCalled();
  });

  it("registers nothing when the host cannot reach the container, even if the setting is saved on", () => {
    sync.call(appThis({ enabled: true, capable: false, bridge: new FakeIcloudBridge() }).self);
    const t = appThis({ enabled: true, capable: true });
    sync.call(t.self);
    expect(t.self.icloudSyncPlugin).toBeUndefined();
    expect(t.register).not.toHaveBeenCalled();
  });

  it("loads when enabled and capable, replaces itself on a re-sync, and unloads when turned off", () => {
    const t = appThis({ enabled: true, capable: true, bridge: new FakeIcloudBridge() });
    sync.call(t.self);
    expect(t.self.icloudSyncPlugin).toBeInstanceOf(IcloudSyncPlugin);
    expect(t.register).toHaveBeenCalledTimes(1);
    sync.call(t.self);
    expect(t.unregister).toHaveBeenCalledTimes(1);
    expect(t.register).toHaveBeenCalledTimes(2);
    t.self.settings.icloudSyncEnabled = false;
    sync.call(t.self);
    expect(t.self.icloudSyncPlugin).toBeUndefined();
    expect(t.unregister).toHaveBeenCalledTimes(2);
  });
});

describe("iCloud container IPC", () => {
  let documents: string;
  beforeEach(() => {
    documents = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-ipc-"));
    fs.mkdirSync(path.join(documents, "R"));
    fs.writeFileSync(path.join(documents, "R", "a.md"), "hello");
  });
  afterEach(() => fs.rmSync(documents, { recursive: true, force: true }));
  const node = () => new NodeIcloudContainer({ locate: createContainerLocator({ env: { GEODE_ICLOUD_BASE: documents } }), platform: "linux" });

  it("dispatches only allowlisted methods", async () => {
    const bridge = node();
    for (const method of ["__proto__", "constructor", "close", "locate", "hashCache", 42, undefined]) {
      expect(await dispatchIcloudCall(bridge, method, [], signal())).toMatchObject({ ok: false, error: { code: "failed" } });
    }
    expect(await dispatchIcloudCall(bridge, "listRoots", "not-an-array", signal())).toMatchObject({ ok: false });
    expect(await dispatchIcloudCall(bridge, "listRoots", [], signal())).toEqual({ ok: true, value: ["R"] });
  });

  it("maps failures to plain codes the renderer can rebuild", () => {
    expect(toFailure(new IcloudBridgeError("precondition-failed", "x"))).toEqual({ code: "precondition-failed", message: "x" });
    expect(toFailure(Object.assign(new Error("gone"), { code: "ENOENT" }))).toMatchObject({ code: "not-found" });
    expect(toFailure(Object.assign(new Error("nope"), { code: "EPERM" }))).toMatchObject({ code: "unavailable" });
    expect(toFailure(Object.assign(new Error("a"), { name: "AbortError" }))).toMatchObject({ code: "aborted" });
    expect(toFailure("weird")).toEqual({ code: "failed", message: "weird" });
  });

  it("round-trips through the renderer wrapper: typed results, typed errors, ArrayBuffer payloads, abort", async () => {
    const backing = node();
    const inflight = new Map<string, AbortController>();
    const bridge = createIpcIcloudBridge(
      {
        call: async (method, args, requestId): Promise<IcloudBridgeResponse> => {
          const abort = new AbortController();
          inflight.set(requestId, abort);
          // structuredClone is what Electron IPC does to arguments and results.
          return structuredClone(await dispatchIcloudCall(backing, method, structuredClone(args), abort.signal));
        },
        abort: (requestId) => inflight.get(requestId)?.abort(),
      },
      (() => {
        let n = 0;
        return () => `req-${n++}`;
      })(),
    );
    expect(await bridge.availability()).toMatchObject({ state: "available" });
    const stat = (await bridge.stat("R", "a.md", OPTS))!;
    expect(stat.revision).toMatch(/^\d+:5:[0-9a-f]{64}$/);
    const handle = await bridge.beginWrite("R", "new.md");
    await bridge.appendChunk(handle, new TextEncoder().encode("payload").buffer as ArrayBuffer);
    const written = await bridge.commitWrite(handle, { absent: true }, OPTS);
    expect(written.size).toBe(7);
    expect(new TextDecoder().decode((await bridge.read("R", "new.md", { expectedRevision: written.revision })).bytes)).toBe("payload");
    await expect(bridge.beginWrite("R", "../escape")).rejects.toMatchObject({ name: "IcloudBridgeError", code: "invalid-path" });
    const second = await bridge.beginWrite("R", "new.md");
    await expect(bridge.commitWrite(second, { absent: true }, OPTS)).rejects.toMatchObject({ code: "precondition-failed" });
    const controller = new AbortController();
    controller.abort();
    await expect(bridge.walk("R", "", OPTS, controller.signal)).rejects.toMatchObject({ code: "aborted" });
  });

  it("aborting a call in flight cancels it in the main process", async () => {
    const backing = node();
    fs.writeFileSync(path.join(documents, "R", ".Slow.md.icloud"), "plist");
    const inflight = new Map<string, AbortController>();
    const bridge = createIpcIcloudBridge(
      {
        call: async (method, args, requestId) => {
          const abort = new AbortController();
          inflight.set(requestId, abort);
          return dispatchIcloudCall(backing, method, args, abort.signal);
        },
        abort: (requestId) => inflight.get(requestId)?.abort(),
      },
      () => "only",
    );
    const controller = new AbortController();
    const pending = bridge.waitForDownload("R", ["Slow.md"], { timeoutMs: 60_000, pollMs: 5 }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("registerIcloudContainerIpc gives each window its own bridge, closes it with the window, and routes aborts", async () => {
    const handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
    const listeners = new Map<string, (event: any, ...args: any[]) => void>();
    const ipcMain = { handle: (channel: string, fn: any) => void handlers.set(channel, fn), on: (channel: string, fn: any) => void listeners.set(channel, fn) };
    const created: Array<{ closed: boolean; bridge: NodeIcloudContainer }> = [];
    registerIcloudContainerIpc(ipcMain as any, () => {
      const bridge = node();
      const record = { closed: false, bridge };
      const close = bridge.close.bind(bridge);
      bridge.close = async () => {
        record.closed = true;
        await close();
      };
      created.push(record);
      return bridge;
    });
    let destroyed: (() => void) | undefined;
    const sender = (id: number) => ({ id, once: (_event: string, fn: () => void) => void (destroyed = fn) });
    const handle = handlers.get("icloud-container")!;
    expect(await handle({ sender: sender(1) }, "listRoots", [], "r1")).toEqual({ ok: true, value: ["R"] });
    await handle({ sender: sender(1) }, "listRoots", [], "r2");
    expect(created).toHaveLength(1);
    await handle({ sender: sender(2) }, "listRoots", [], "r3");
    expect(created).toHaveLength(2);

    fs.writeFileSync(path.join(documents, "R", ".Slow.md.icloud"), "plist");
    const slow = handle({ sender: sender(1) }, "waitForDownload", ["R", ["Slow.md"], { timeoutMs: 60_000, pollMs: 5 }], "slow");
    setTimeout(() => listeners.get("icloud-container-abort")!({ sender: { id: 1 } }, "slow"), 20);
    expect(await slow).toMatchObject({ ok: false, error: { code: "aborted" } });

    destroyed?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(created.some((c) => c.closed)).toBe(true);
  });
});
