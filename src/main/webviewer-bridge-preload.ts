import { contextBridge, ipcRenderer, webFrame } from "electron";
import { WEBVIEWER_BRIDGE_CHANNEL } from "../shared/web-viewer-connectors";
import {
  POPUP_CLAIM_HANDLE_CHANNEL,
  POPUP_CLAIM_OPENER_CHANNEL,
  POPUP_CONTROL_CHANNEL,
  POPUP_POST_TO_OPENER_CHANNEL,
  POPUP_POST_TO_POPUP_CHANNEL,
  POPUP_RELAY_CHANNEL,
  type PopupControlRequest,
  type PopupRelayMessage,
} from "./webviewer-popups";

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

// --- Popup/opener shim ------------------------------------------------------
//
// Geode denies real popups and reparents the URL into a new Web Viewer tab
// (see main.ts's window-open handler and src/main/webviewer-popups.ts). That
// leaves `window.open()` returning null and `window.opener` null, which breaks
// the standard OAuth popup handshake. The code below restores just the
// cross-origin `WindowProxy` surface those two expose, routed through main.
//
// It must run in the page's MAIN world, and `contextBridge` cannot put it
// there: `exposeInMainWorld("opener", …)` throws "Cannot bind an API on top of
// an existing property on the window object", and `window.open` is likewise
// already defined. `webFrame.executeJavaScript` from a sandboxed preload does
// evaluate in the main world, and — measured, not assumed — lands before the
// page's own inline `<script>` tags run, which is the ordering the whole shim
// depends on.

/**
 * The narrow relay primitives the main-world shim needs. Every one of them is
 * re-validated in main against `event.sender`/`event.senderFrame`, so this
 * object grants a page nothing it could not already do: it can only address
 * the popup it itself opened, or the opener that opened it.
 *
 * Measured behavior of contextBridge (Electron 42): properties are installed
 * non-configurable and non-writable, so the `delete` the shim attempts below
 * cannot succeed and this name stays visible to the page. That is not fought
 * here — hiding it would be defense in depth against nothing, given main
 * validates authoritatively — but it does mean the surface must stay this
 * narrow, and that a page can detect Geode by sniffing for it (as it already
 * can via `window.__geode`).
 */
let relayHandler: ((message: PopupRelayMessage) => void) | null = null;

ipcRenderer.on(POPUP_RELAY_CHANNEL, (_event, message: PopupRelayMessage) => {
  try {
    relayHandler?.(message);
  } catch {
    // A page that broke its own message handler must not break the preload.
  }
});

contextBridge.exposeInMainWorld("__geodePopupsInternal", {
  claimHandle: () => ipcRenderer.sendSync(POPUP_CLAIM_HANDLE_CHANNEL) as { handleId: string; url: string } | null,
  claimOpener: () => ipcRenderer.sendSync(POPUP_CLAIM_OPENER_CHANNEL) as { hasOpener: boolean; handleId?: string },
  postToOpener: (message: unknown, targetOrigin: string) => {
    ipcRenderer.send(POPUP_POST_TO_OPENER_CHANNEL, { message, targetOrigin });
  },
  postToPopup: (handleId: string, message: unknown, targetOrigin: string) => {
    ipcRenderer.send(POPUP_POST_TO_POPUP_CHANNEL, { handleId, message, targetOrigin });
  },
  control: (request: PopupControlRequest) => {
    ipcRenderer.send(POPUP_CONTROL_CHANNEL, request);
  },
  /**
   * Single-shot by design. The shim registers before any page script can run,
   * so a later caller is by definition not us — and letting it replace the
   * handler would let page code intercept messages the shim is meant to
   * deliver as real `MessageEvent`s.
   */
  onRelay: (callback: (message: PopupRelayMessage) => void) => {
    if (relayHandler) return false;
    relayHandler = callback;
    return true;
  },
});

/**
 * The main-world half of the shim. Kept as a source string because it is
 * evaluated in a different JavaScript world than this file's own scope; it may
 * close over nothing from here except the `__geodePopupsInternal` object it
 * looks up on `window`.
 */
const MAIN_WORLD_SHIM = `(() => {
  const internal = window.__geodePopupsInternal;
  if (!internal) return;
  // contextBridge installs non-configurable properties, so this cannot
  // succeed (measured on Electron 42: delete returns false, defineProperty
  // throws "Cannot redefine property"). Attempted anyway so the intent is
  // recorded where the constraint lives, and so it starts working for free if
  // Electron ever relaxes it.
  try { delete window.__geodePopupsInternal; } catch (e) {}

  const nativeOpen = typeof window.open === "function" ? window.open : null;
  /** handleId -> { handle, state } for popups this page opened. */
  const popups = new Map();
  let openerEntry = null;
  let openerHandle = null;

  /**
   * Exactly the surface a cross-origin WindowProxy exposes. Same-origin
   * access (opener.document, arbitrary property reads, named frame access) is
   * deliberately NOT emulated: the two pages live in separate, unrelated
   * Chromium browsing contexts here, so there is nothing real to expose and a
   * fake would be worse than an honest absence.
   */
  function createHandle(kind, handleId) {
    const state = { closed: false };
    const handle = {
      postMessage: function (message, targetOrigin) {
        // The modern spec defaults targetOrigin to "/" (sender's own origin).
        const target = (targetOrigin === undefined || targetOrigin === null) ? "/" : String(targetOrigin);
        if (kind === "popup") internal.postToPopup(handleId, message, target);
        else internal.postToOpener(message, target);
      },
      close: function () {
        // Chromium refuses close() on a window the script did not open, and
        // the opener tab was opened by the user. Matching that refusal keeps
        // a popup from closing the tab the user was actually working in.
        if (kind !== "popup") return;
        internal.control({ target: "popup", handleId: handleId, action: "close" });
      },
      focus: function () {
        internal.control({ target: kind, handleId: handleId, action: "focus" });
      },
      blur: function () {
        // No host equivalent: Geode tabs have no "send to back". A no-op
        // matches what browsers increasingly do with blur() anyway.
      },
    };
    Object.defineProperty(handle, "closed", { get: function () { return state.closed; }, enumerable: true });
    return { handle: handle, state: state };
  }

  window.open = function open(url, target, features) {
    // Native first: it is what actually reaches main's window-open handler,
    // which records the pending request this call then claims. Anything the
    // handler does not forward (non-http schemes, _self navigations, a
    // genuinely blocked popup) produces no pending entry, and the native
    // result is returned untouched so behavior is unchanged from before.
    const nativeResult = nativeOpen ? nativeOpen.apply(window, arguments) : null;
    let claim = null;
    try { claim = internal.claimHandle(); } catch (e) { claim = null; }
    if (!claim || typeof claim.handleId !== "string") return nativeResult;
    const entry = createHandle("popup", claim.handleId);
    popups.set(claim.handleId, entry);
    return entry.handle;
  };

  internal.onRelay(function (message) {
    if (!message || typeof message !== "object") return;
    if (message.kind === "message") {
      const entry = message.from === "popup" ? popups.get(message.handleId) : openerEntry;
      const event = new MessageEvent("message", {
        data: message.data,
        origin: message.origin,
        // MessageEvent's initializer only accepts a real Window/MessagePort,
        // so source is shadowed as an own property afterwards. That is what
        // makes the usual "e.source === popupRef" identity check pass.
        source: null,
      });
      try {
        Object.defineProperty(event, "source", { value: entry ? entry.handle : null, configurable: true });
      } catch (e) {}
      window.dispatchEvent(event);
      return;
    }
    if (message.kind === "popup-closed") {
      const entry = popups.get(message.handleId);
      if (entry) entry.state.closed = true;
      return;
    }
    if (message.kind === "opener-gone") {
      if (openerEntry) openerEntry.state.closed = true;
      openerHandle = null;
    }
  });

  // Only define window.opener when main says this guest really was opened by
  // another one. Sites use "if (window.opener)" to detect popup-ness, so
  // defining it on every Web Viewer tab would be a real behavior regression.
  let claimedOpener = null;
  try { claimedOpener = internal.claimOpener(); } catch (e) { claimedOpener = null; }
  if (claimedOpener && claimedOpener.hasOpener === true && typeof claimedOpener.handleId === "string") {
    openerEntry = createHandle("opener", claimedOpener.handleId);
    openerHandle = openerEntry.handle;
    Object.defineProperty(window, "opener", {
      configurable: true,
      enumerable: true,
      get: function () { return openerHandle; },
      set: function (value) { openerHandle = value; },
    });
  }
})();`;

// Fire-and-forget: a page that navigates out from under the injection rejects
// this promise, and there is nothing useful to do about it — the next document
// gets its own preload run and its own injection.
void webFrame.executeJavaScript(MAIN_WORLD_SHIM).catch(() => {});
