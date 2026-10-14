import { Capacitor, CapacitorHttp } from "@capacitor/core";

/**
 * On iOS the redeem request goes through CapacitorHttp (native URLSession), exactly like the Supported plugins downloads
 * (mobile-http-transport.ts): the WebView CSP stays `connect-src 'self' wss:`, there is no CORS preflight to the desktop, and
 * ATS (`NSAllowsLocalNetworking`) is what permits cleartext only to local addresses. On the web build there is no native
 * transport, so `undefined` is returned and the plain `fetch` (and its CSP) applies. Only the one POST the client makes is supported.
 */
export function createPairingFetch(): typeof fetch | undefined {
  if (!Capacitor.isNativePlatform()) return undefined;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method !== "POST" || typeof init.body !== "string") throw new TypeError("Unsupported pairing request");
    const timeout = 8000;
    const response = await CapacitorHttp.post({ url, headers: { "content-type": "application/json" }, data: JSON.parse(init.body), responseType: "text", connectTimeout: timeout, readTimeout: timeout, disableRedirects: true });
    const body = typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "");
    return new Response(body, { status: response.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
