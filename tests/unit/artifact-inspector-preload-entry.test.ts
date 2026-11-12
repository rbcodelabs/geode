import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSPECT_CHANNEL } from "../../src/artifacts/inspector-protocol";

const ipcRenderer = { sendToHost: vi.fn(), on: vi.fn() };
const contextBridge = { exposeInMainWorld: vi.fn() };
vi.mock("electron", () => ({ ipcRenderer, contextBridge }));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });

describe("artifact-inspector-preload entry", () => {
  it("sends ready to the host, listens only on the four embedder channels and exposes nothing to the page", async () => {
    const dom = new JSDOM("<body></body>", { url: "https://artifact.test/" });
    vi.stubGlobal("window", dom.window);
    await import("../../src/main/artifact-inspector-preload");
    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith(INSPECT_CHANNEL.ready, { protocol: 1 });
    expect(ipcRenderer.on.mock.calls.map((c) => c[0]).sort()).toEqual([INSPECT_CHANNEL.key, INSPECT_CHANNEL.mode, INSPECT_CHANNEL.anchors, INSPECT_CHANNEL.anchorFocus].sort());
    expect(contextBridge.exposeInMainWorld).not.toHaveBeenCalled();
    // an embedder mode message flows through the wrapper (the IPC event argument is dropped)
    const modeHandler = ipcRenderer.on.mock.calls.find((c) => c[0] === INSPECT_CHANNEL.mode)![1] as (e: unknown, p: unknown) => void;
    expect(() => modeHandler({ senderId: 1 }, { mode: "pick", redactText: false })).not.toThrow();
  });

  it("does nothing in a sub-frame", async () => {
    const dom = new JSDOM("<body><iframe></iframe></body>", { url: "https://artifact.test/" });
    vi.stubGlobal("window", dom.window.document.querySelector("iframe")!.contentWindow);
    await import("../../src/main/artifact-inspector-preload");
    expect(ipcRenderer.sendToHost).not.toHaveBeenCalled();
  });
});
