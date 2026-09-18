import { contextBridge, ipcRenderer } from "electron";
import { WEBVIEWER_BRIDGE_CHANNEL } from "../shared/web-viewer-connectors";
import { WEBAUTHN_ESCALATION_CHANNEL, type WebAuthnEscalationMessage } from "../shared/webauthn-escalation";

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
  postWebAuthnEscalationSignal: (message: WebAuthnEscalationMessage) => {
    ipcRenderer.send(WEBAUTHN_ESCALATION_CHANNEL, message);
  },
});

// Wrap navigator.credentials.create()/get() in the guest's MAIN world (not
// this isolated preload context — a monkey-patch here would never see calls
// made by the page's own scripts). Appending a <script> element is the
// standard technique for this: the DOM tree is shared across isolated
// worlds even though JS globals are not, and script elements always execute
// in the document's principal (main) world. This runs at guest document
// creation, before any page script — Electron guarantees preload scripts
// run before the guest's own scripts — so the wrapper is in place before the
// real page can grab an unwrapped reference to either method.
//
// Only a REJECTED ceremony is reported (see webauthn-escalation.ts's shared
// module doc comment for why this channel is deliberately unrestricted by
// origin): a resolved call needs no fallback, and forwarding every attempt
// would leak ceremony metadata for origins that never asked for escalation.
const WEBAUTHN_WRAPPER_SOURCE = `(() => {
  if (!window.PublicKeyCredential || !navigator.credentials) return;
  const report = (ceremony, err) => {
    if (window.__geode && typeof window.__geode.postWebAuthnEscalationSignal === "function") {
      window.__geode.postWebAuthnEscalationSignal({
        ceremony,
        errorName: (err && err.name) || "Error",
        errorMessage: (err && err.message) || String(err),
      });
    }
  };
  for (const ceremony of ["create", "get"]) {
    const original = navigator.credentials[ceremony].bind(navigator.credentials);
    navigator.credentials[ceremony] = (options) => {
      if (!options || !options.publicKey) return original(options);
      return original(options).catch((err) => {
        report(ceremony, err);
        throw err;
      });
    };
  }
})();`;

/**
 * Inject the wrapper as early as possible (synchronously, at preload time —
 * before the page's own scripts run), falling back to DOMContentLoaded only
 * if `document.head`/`documentElement` don't exist yet at that point. A
 * WebAuthn ceremony is essentially always user-interaction-gated (a button
 * click, well after load), so even the DOMContentLoaded fallback installs
 * the wrapper before any realistic page code could call
 * `navigator.credentials.create()`/`.get()` — only a synchronous, parse-time
 * ceremony call (not a pattern any real relying party uses) could race it.
 */
function injectWebAuthnWrapper(): boolean {
  const target = document.head ?? document.documentElement;
  if (!target) return false;
  try {
    const script = document.createElement("script");
    script.textContent = WEBAUTHN_WRAPPER_SOURCE;
    target.appendChild(script);
    script.remove();
    return true;
  } catch {
    // A guest whose CSP blocks inline scripts simply gets no automatic
    // escalation signal. The manual "Continue in a separate window" page
    // action (web-view.ts) still works regardless.
    return true;
  }
}

if (!injectWebAuthnWrapper()) {
  window.addEventListener("DOMContentLoaded", () => injectWebAuthnWrapper(), { once: true });
}
