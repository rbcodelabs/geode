import { ipcRenderer } from "electron";
import { startInspector } from "./artifact-inspector-guest";

/**
 * Host-owned element inspector for static artifacts (ADR 0006 D4/D5), registered on
 * the artifact session with `registerPreloadScript({ type: "frame" })`. It exposes
 * NOTHING to the page: no contextBridge, no globals. It only talks to the embedding
 * renderer through `sendToHost`, which the renderer-side bridge treats as untrusted
 * data. All behavior lives in `artifact-inspector-guest.ts` so it is testable
 * without Electron; this entry is the wiring.
 */
startInspector({
  window,
  ipc: {
    send: (channel, payload) => ipcRenderer.sendToHost(channel, payload),
    on: (channel, handler) => { ipcRenderer.on(channel, (_event, payload: unknown) => handler(payload)); },
  },
});
