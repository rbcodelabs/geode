import type { HostServices } from "./contracts";

/**
 * Obsidian plugins (including Google Docs Sync's OAuth start) call
 * `window.open(url)` to reach the system browser. A Capacitor WKWebView would
 * either navigate the app away or ignore the call, so mobile routes http(s)
 * URLs through the host's external-URL service and refuses everything else.
 * Returns a restore function.
 */
export function installMobileWindowOpen(host: Pick<HostServices, "navigation">, target: Window = window): () => void {
  const original = target.open;
  target.open = ((url?: string | URL, _target?: string, _features?: string): Window | null => {
    if (url === undefined || url === null || url === "") return null;
    let parsed: URL;
    try { parsed = new URL(String(url), target.location.href); } catch { return null; }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    void host.navigation.openExternal(parsed.href).catch((error) => console.error("Failed to open external URL", error));
    return null;
  }) as typeof target.open;
  return () => { target.open = original; };
}
