/**
 * Top-level-window escalation for WebAuthn ceremonies a relying party
 * rejects inside Geode's embedded Web Viewer `<webview>` (Compass assumption
 * `690ae6b7-e170-466e-b745-6161df6631ab`). See
 * src/shared/webauthn-escalation.ts for why detection is guest-reported and
 * unrestricted by origin, and web-view.ts for the two ways this gets
 * triggered (an automatic rejection signal, or the user's own "Continue in
 * a separate window" page action).
 *
 * Session merge-back deliberately does NOT copy cookies after the fact the
 * way chrome-cookies.ts does. `chrome-cookies.ts` has to copy because it's
 * importing from an entirely separate program's (Chrome's) storage. Here,
 * the escalation window is opened on the Web Viewer's own
 * `persist:webviewer` partition — the exact same Electron `Session` instance
 * every Web Viewer tab's guest already uses (see web-view.ts's
 * `setAttribute("partition", ...)`). Electron shares cookies/localStorage
 * live across every WebContents on one partition string, so whatever the
 * user authenticates in the escalation window is immediately visible to the
 * original tab once it reloads — no explicit copy step, no window where the
 * two sessions could drift apart.
 */
import { BrowserWindow, session } from "electron";

export const WEBVIEWER_PARTITION = "persist:webviewer";

export interface EscalationResult {
  /** The escalation window closed (by the user, or the app quitting). */
  closed: true;
  /**
   * Best-effort signal that a cookie was actually set for the target origin
   * while the window was open — not proof of a successful ceremony (a
   * relying party may set cookies before/without completing WebAuthn), but
   * a useful "something happened" indicator for the caller's reload/no-op
   * decision and for test assertions.
   */
  cookieObserved: boolean;
}

/**
 * Open a real top-level `BrowserWindow` scoped to `url`'s origin, sharing
 * the Web Viewer's session partition, and resolve once the user closes it.
 *
 * `parent`: the app window the request came from — the escalation window is
 * a real child window (not a guest), so it gets its own title bar, its own
 * top-level browsing context, and is NOT the reused/hidden `<webview>` guest
 * that a rejecting relying party already refused.
 *
 * `isHeadless`: mirrors main.ts's `createWindow` — under `GEODE_HEADLESS=1`
 * (E2E runs) the window is created with `show: false`, same as every other
 * window in this app, so a test run never pops a visible window.
 */
export function openEscalationWindow(
  parent: BrowserWindow,
  url: string,
  isHeadless: boolean
): Promise<EscalationResult> {
  return new Promise((resolve) => {
    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch {
      // Malformed URL: still open the window (loadURL will simply fail and
      // the user sees Chromium's own error page), just skip cookie tracking.
    }

    const win = new BrowserWindow({
      parent,
      show: !isHeadless,
      width: 480,
      height: 680,
      title: `Continue sign-in${hostname ? ` — ${hostname}` : ""}`,
      webPreferences: {
        partition: WEBVIEWER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    // BrowserWindow syncs its title to the loaded page's <title> by default
    // (page-title-updated is a BrowserWindow event, not a webContents one —
    // attaching this to `win.webContents` instead of `win` is a real, easy
    // mistake that silently no-ops rather than erroring). Keep the
    // purposeful "Continue sign-in — host" title instead, so the window
    // stays identifiable as Geode's own escalation surface rather than
    // flashing whatever title the relying party's page happens to set.
    win.on("page-title-updated", (event) => event.preventDefault());

    let cookieObserved = false;
    const target = session.fromPartition(WEBVIEWER_PARTITION);
    const onCookieChanged = (
      _event: Electron.Event,
      cookie: Electron.Cookie,
      _cause: string,
      removed: boolean
    ) => {
      if (!removed && hostname && (cookie.domain ?? "").replace(/^\./, "") === hostname) {
        cookieObserved = true;
      }
    };
    target.cookies.on("changed", onCookieChanged);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      target.cookies.removeListener("changed", onCookieChanged);
      // Same durability step chrome-cookies.ts takes after its own cookie
      // writes: force the persistent partition's cookie store to disk
      // rather than trusting it was already flushed by the time the window
      // closes. Best-effort — a flush failure shouldn't block reporting the
      // ceremony's outcome back to the tab, so this never rejects the
      // caller's promise.
      void target.cookies.flushStore().finally(() => {
        resolve({ closed: true, cookieObserved });
      });
    };
    win.once("closed", finish);

    void win.loadURL(url).catch(() => {
      // A load failure (offline, bad URL, RP-side redirect loop) still lets
      // the user see and close the real window; closed → finish() above.
    });
  });
}
