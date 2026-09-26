import { installPopupOpenerShim } from "./popup-opener-shim";

// Preload for the Claude Threads plugin's "Agent Browser" guest `<webview>`s
// only (partition "persist:agent-browser", forced by main.ts's
// `will-attach-webview` handler — see AGENT_BROWSER_PARTITION there). These
// guests navigate to arbitrary, agent-driven, attacker-controlled URLs, which
// is a materially different trust posture than the Web Viewer's own
// `<webview>`s: a human is not necessarily looking at the page, and the page
// was not necessarily chosen by the user. See docs/adr/0022-agent-browser-
// popup-bridge.md for the full design.
//
// This preload installs *only* the popup/opener shim
// (src/main/popup-opener-shim.ts), which restores `window.open`/
// `window.opener` on top of Geode's deny-and-reparent popup handling so an
// OAuth-style login handoff can work inside an Agent Browser guest. It
// deliberately does NOT call `contextBridge.exposeInMainWorld("__geode", …)`
// the way webviewer-bridge-preload.ts does for the Web Viewer: that general
// event bridge (`window.__geode.postEvent`) lets a page reach into the host
// renderer, and handing that to an agent-navigable page would be a real
// privilege escalation. The omission is the entire security property here —
// enforced by this file simply not containing that code, not by a runtime
// check that could be gotten wrong.
installPopupOpenerShim();
