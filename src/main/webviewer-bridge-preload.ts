import { contextBridge, ipcRenderer } from "electron";
import { WEBVIEWER_BRIDGE_CHANNEL } from "../shared/web-viewer-connectors";

// Preload for the Web Viewer's guest `<webview>` only (partition
// "persist:webviewer") — never for the main window, which intentionally runs
// with contextIsolation: false to host plugins as trusted, unisolated code
// (see main.ts's `webPreferences` on `createWindow` and its comment). This
// guest runs with contextIsolation: true and sandbox: true (see main.ts's
// `will-attach-webview` handler), so contextBridge is safe to use
// unconditionally here.
contextBridge.exposeInMainWorld("__geode", {
  postEvent: (type: string, payload?: unknown) => {
    if (typeof type !== "string") return;
    ipcRenderer.send(WEBVIEWER_BRIDGE_CHANNEL, { type, payload });
  },
});
