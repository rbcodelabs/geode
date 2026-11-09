import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in for an Electron Session that records every call the runtime makes on it. */
class FakeSession {
  readonly registered = new Map<string, { type: string; filePath: string }>();
  readonly unregistered: string[] = [];
  registerThrows = false;
  unregisterThrows = false;
  private nextId = 1;
  setPermissionCheckHandler = vi.fn();
  setPermissionRequestHandler = vi.fn();
  setDevicePermissionHandler = vi.fn();
  setDisplayMediaRequestHandler = vi.fn();
  on = vi.fn();
  webRequest = { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() };
  protocol = { handle: vi.fn(async () => {}), unhandle: vi.fn() };
  clearCache = vi.fn(async () => {});
  clearStorageData = vi.fn(async () => {});
  registerPreloadScript = vi.fn((script: { type: string; filePath: string }) => {
    if (this.registerThrows) throw new Error("register failed");
    const id = `preload-${this.nextId++}`;
    this.registered.set(id, script);
    return id;
  });
  unregisterPreloadScript = vi.fn((id: string) => {
    if (this.unregisterThrows) throw new Error("unregister failed");
    this.unregistered.push(id);
    this.registered.delete(id);
  });
}

const sessions: Array<{ partition: string; session: FakeSession }> = [];
const windows: Array<{ webPreferences: { session: FakeSession } }> = [];
let failNextProtocolHandle = false;
let failNextRegister = false;

vi.mock("electron", () => {
  class FakeContents {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    setFrameRate() {}
    setWindowOpenHandler() {}
    on(event: string, cb: (...args: unknown[]) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]); }
    once(event: string, cb: (...args: unknown[]) => void) { this.on(event, cb); }
    async loadURL() { for (const cb of this.handlers.get("did-finish-load") ?? []) cb(); }
    async capturePage() { return { toPNG: () => Buffer.from([1, 2, 3]), getSize: () => ({ width: 1, height: 1 }) }; }
  }
  class BrowserWindow {
    webContents = new FakeContents();
    constructor(options: { webPreferences: { session: FakeSession } }) { windows.push(options); }
    isDestroyed() { return false; }
    destroy() {}
  }
  return {
    BrowserWindow,
    session: {
      fromPartition(partition: string) {
        const session = new FakeSession();
        if (failNextRegister) { failNextRegister = false; session.registerThrows = true; }
        if (failNextProtocolHandle) { failNextProtocolHandle = false; session.protocol.handle = vi.fn(async () => { throw new Error("handle failed"); }); }
        sessions.push({ partition, session });
        return session;
      },
    },
  };
});

import { ArtifactRuntime } from "../../src/main/artifact-runtime";

const owner = { id: 7 } as never;
let dir: string;
let warn: ReturnType<typeof vi.spyOn>;

async function writeArtifact(manifest: Record<string, unknown>): Promise<string> {
  await writeFile(path.join(dir, "artifact.json"), JSON.stringify(manifest));
  const entry = String(manifest.entry);
  await mkdir(path.dirname(path.join(dir, entry)), { recursive: true });
  await writeFile(path.join(dir, entry), "<html></html>");
  return dir;
}
const staticManifest = {
  schemaVersion: 1, id: "demo", title: "Demo", entry: "index.html", runtime: "static",
  createdByThreadId: "t1", viewport: { preset: "desktop", width: 1440, height: 900 },
  permissions: { network: "none", clipboard: false },
};
const vaultManifest = { ...staticManifest, permissions: { network: "none", clipboard: false, vault: "read", vaultAllowlist: ["Tasks.base"] } };
const nextjsManifest = {
  schemaVersion: 2, id: "demo-next", title: "Next", entry: "app/page.tsx", runtime: "nextjs",
  createdByThreadId: "t1", viewport: { preset: "desktop", width: 1440, height: 900 },
  permissions: { network: "loopback", clipboard: false },
};

beforeEach(async () => {
  sessions.length = 0;
  windows.length = 0;
  failNextProtocolHandle = false;
  failNextRegister = false;
  dir = await mkdtemp(path.join(os.tmpdir(), "geode-rt-"));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => { warn.mockRestore(); await rm(dir, { recursive: true, force: true }); });

const runtime = () => new ArtifactRuntime("/dist/vault-preload.js", "/dist/inspector-preload.js");

describe("ArtifactRuntime inspector preload", () => {
  it("registers the inspector once per static artifact session as a frame preload and flags the registration", async () => {
    const root = await writeArtifact(staticManifest);
    const rt = runtime();
    const reg = await rt.register(owner, root);
    expect(sessions).toHaveLength(1);
    const { session } = sessions[0]!;
    expect(session.registerPreloadScript).toHaveBeenCalledTimes(1);
    expect(session.registerPreloadScript).toHaveBeenCalledWith({ type: "frame", filePath: "/dist/inspector-preload.js" });
    expect(reg.inspector).toEqual({ protocol: 1 });
    expect(JSON.parse(JSON.stringify(reg)).inspector).toEqual({ protocol: 1 }); // survives IPC cloning
  });

  it("registers nothing for a nextjs artifact and does not flag it", async () => {
    const root = await writeArtifact(nextjsManifest);
    const reg = await runtime().register(owner, root, { devServerUrl: "http://127.0.0.1:3000" });
    expect(sessions[0]!.session.registerPreloadScript).not.toHaveBeenCalled();
    expect(reg.inspector).toBeUndefined();
  });

  it("does not register on the offscreen capture session of a nextjs artifact", async () => {
    const root = await writeArtifact(nextjsManifest);
    const rt = runtime();
    await rt.capture(owner, root, { url: "http://127.0.0.1:3000" });
    expect(sessions).toHaveLength(1); // the throwaway capture session
    expect(sessions[0]!.partition).toMatch(/^geode-artifact-capture-/);
    expect(sessions[0]!.session.registerPreloadScript).not.toHaveBeenCalled();
    expect(windows[0]!.webPreferences.session).toBe(sessions[0]!.session);
  });

  it("still opens the artifact when the registration throws, without the flag", async () => {
    const root = await writeArtifact(staticManifest);
    failNextRegister = true; // the session is created inside register(), so arm the next one
    const reg = await runtime().register(owner, root);
    expect(reg.entryUrl).toBe("geode-artifact://demo/index.html");
    expect(reg.inspector).toBeUndefined();
    expect(sessions[0]!.session.registerPreloadScript).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it("registers only after the session was configured: a configuration failure registers nothing", async () => {
    const root = await writeArtifact(staticManifest);
    failNextProtocolHandle = true;
    await expect(runtime().register(owner, root)).rejects.toThrow("handle failed");
    expect(sessions[0]!.session.registerPreloadScript).not.toHaveBeenCalled();
  });

  it("unregisters the preload on unregister and on owner teardown, tolerating an unregister failure", async () => {
    const root = await writeArtifact(staticManifest);
    const rt = runtime();
    const reg = await rt.register(owner, root);
    const { session } = sessions[0]!;
    expect(await rt.unregister(owner, reg.registrationId)).toBe(true);
    expect(session.unregisterPreloadScript).toHaveBeenCalledWith("preload-1");
    expect(session.unregisterPreloadScript).toHaveBeenCalledTimes(1);

    const rt2 = runtime();
    await rt2.register(owner, root);
    const second = sessions[1]!.session;
    second.unregisterThrows = true;
    await rt2.unregisterOwner(7);
    expect(second.unregisterPreloadScript).toHaveBeenCalledTimes(1);
    expect(second.clearCache).toHaveBeenCalled(); // dispose carried on past the failure
  });

  it("leaves webPreferences.preload exactly as before: vault bridge only when the manifest opted in", async () => {
    const root = await writeArtifact(vaultManifest);
    const rt = runtime();
    const vaultReg = await rt.register(owner, root);
    const prefs: Record<string, unknown> = {};
    expect(rt.secureWebviewAttachment(owner, prefs as never, { partition: vaultReg.partition })).toBe(true);
    expect(prefs.preload).toBe("/dist/vault-preload.js");
    expect(vaultReg.inspector).toEqual({ protocol: 1 }); // both coexist
    expect(sessions[0]!.session.registerPreloadScript).toHaveBeenCalledTimes(1);

    const root2 = await writeArtifact(staticManifest);
    const plain = await rt.register(owner, root2);
    const prefs2: Record<string, unknown> = { preload: "stale" };
    rt.secureWebviewAttachment(owner, prefs2 as never, { partition: plain.partition });
    expect(prefs2.preload).toBeUndefined();
  });
});
