/**
 * IPC payload for a plugin's raw `fetch()` call, proxied through the main
 * process to bypass the renderer's CSP (no `connect-src` override — see
 * `tests/unit/renderer-csp.test.ts`). Sibling to `PrivilegedRequestUrlParam`
 * in `request-url.ts`, but carries pre-serialized body bytes for *any* body
 * shape a plugin might pass to `fetch()` (including `FormData`) instead of
 * `requestUrl`'s narrower `string | ArrayBuffer`. See `pluginFetch` in
 * `src/renderer/plugin-fetch.ts` for how the renderer produces this payload,
 * and `performPluginFetch` in `src/main/request-url.ts` for how main
 * consumes it.
 */
export interface PrivilegedFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBuffer?: ArrayBuffer;
  /**
   * Whole-request deadline in milliseconds — see the same field on
   * `PrivilegedRequestUrlParam`. Plugins raise it by passing a non-standard
   * numeric `timeout` in their `fetch()` init; see `pluginFetch` in
   * `src/renderer/plugin-fetch.ts`.
   */
  timeout?: number;
}

export interface PrivilegedFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}
