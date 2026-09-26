import { contextBridge, ipcRenderer } from "electron";
import { WEBVIEWER_BRIDGE_CHANNEL } from "../shared/web-viewer-connectors";
import { installPopupOpenerShim } from "./popup-opener-shim";

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

// Popup/opener shim: restores the cross-origin WindowProxy surface Geode's
// deny-and-reparent popup handling otherwise breaks (see
// src/main/popup-opener-shim.ts and src/main/webviewer-popups.ts for the
// mechanism and why it must run in the page's main world). Shared verbatim
// with agent-browser-bridge-preload.ts, which installs the shim but
// deliberately does not install the `__geode` bridge above.
installPopupOpenerShim();
