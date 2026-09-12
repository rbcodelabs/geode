import type { GeodeApi } from "../main/preload";

type PluginFetchProxy = NonNullable<GeodeApi["pluginFetch"]>;

/**
 * `fetch()` proxy injected into installed plugins' compiled bundles (see the
 * doc comment on `instantiatePluginClass` in `plugin-manager.ts` and
 * `compileMobilePluginModule` in `mobile-plugin-runtime.ts`). Plugin code
 * runs in the host's own JS realm, so a bare `fetch(...)` call inside a
 * plugin would otherwise resolve to the ambient `fetch`/`window.fetch` and
 * be blocked by the renderer's `default-src 'self'` CSP (no `connect-src`
 * override — pinned by `tests/unit/renderer-csp.test.ts`) for any remote
 * origin. This is the same class of problem `requestUrl` already solves
 * (see `src/main/request-url.ts`'s `performRequestUrl`), extended to cover
 * plugins that need a raw `fetch()` — most commonly for a `FormData`
 * multipart body, which `requestUrl`'s `RequestUrlParam.body` (only
 * `string | ArrayBuffer`) cannot carry.
 *
 * Constructing a `Request` here performs no network I/O — only *sending*
 * one does — so it isn't itself blocked by the CSP. It exists purely to let
 * the platform's own Fetch implementation correctly serialize whatever body
 * shape the plugin passed (particularly `FormData`, whose multipart
 * boundary only the platform can compute) into raw bytes plus the right
 * `Content-Type` header. Those bytes are then handed over IPC to the main
 * process — not subject to the renderer's CSP at all — to actually send,
 * and the response is reconstructed here as a real `Response` so plugin
 * code sees exactly what native `fetch()` would have returned.
 *
 * Falls back to native `fetch` when there's no privileged bridge to
 * delegate to (`window.geode.pluginFetch` absent — true for non-Electron
 * builds, and for today's Capacitor mobile shell, which has no separate
 * trusted process to hand the request to; see `mobile-plugin-runtime.ts`)
 * or when the URL isn't an absolute `http(s)` URL (mirrors
 * `performRequestUrl`'s guard — a relative same-origin request, or a
 * `data:`/`blob:` URL, isn't blocked by this CSP in the first place and
 * doesn't need proxying).
 */
export function pluginFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const proxy: PluginFetchProxy | undefined =
    typeof window === "undefined" ? undefined : window.geode?.pluginFetch;
  if (!proxy) return fetch(input, init);

  const rawUrl = input instanceof Request ? input.url : String(input);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fetch(input, init);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fetch(input, init);
  }

  return proxyFetch(proxy, input, init);
}

async function proxyFetch(
  proxy: PluginFetchProxy,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // A real Request computes the final method/headers/body exactly as native
  // fetch() would — including a FormData body's boundary-bearing
  // Content-Type, which init.headers never carries on its own.
  const request = new Request(input, init);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const bodyBuffer = hasBody ? await request.arrayBuffer() : undefined;
  const result = await proxy({
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    bodyBuffer: bodyBuffer && bodyBuffer.byteLength > 0 ? bodyBuffer : undefined,
  });
  return new Response(result.arrayBuffer, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}
