import type {
  PrivilegedRequestUrlParam,
  PrivilegedRequestUrlResponse,
} from "../shared/request-url";
import type {
  PrivilegedFetchRequest,
  PrivilegedFetchResponse,
} from "../shared/plugin-fetch";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Absolute HTTP(S)-only URL guard shared by `performRequestUrl` and `performPluginFetch`. */
function validateHttpUrl(rawUrl: string, apiName: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${apiName} requires a valid HTTP(S) URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${apiName} only supports HTTP(S) URLs: ${rawUrl}`);
  }
  return url;
}

export async function performRequestUrl(
  request: PrivilegedRequestUrlParam,
  fetchImpl: Fetch,
): Promise<PrivilegedRequestUrlResponse> {
  const url = validateHttpUrl(request.url, "requestUrl");

  const headers = new Headers(request.headers);
  if (request.contentType) headers.set("Content-Type", request.contentType);
  const response = await fetchImpl(url.href, {
    method: request.method ?? "GET",
    headers,
    body: request.body,
    redirect: "follow",
  });
  const arrayBuffer = await response.arrayBuffer();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  return { status: response.status, headers: responseHeaders, arrayBuffer };
}

/**
 * Sibling to `performRequestUrl` for plugins' raw `fetch()` calls — see the
 * doc comment on `pluginFetch` in `src/renderer/plugin-fetch.ts` for why
 * this exists alongside `requestUrl` rather than replacing it (multipart
 * `FormData` bodies, which `requestUrl` cannot carry). The renderer has
 * already serialized whatever body the plugin passed into raw bytes plus
 * the correct `Content-Type` header (including a `FormData` boundary) by
 * constructing a real `Request` there; this function just replays those
 * bytes over the wire from the main process, which is not subject to the
 * renderer's CSP at all.
 */
export async function performPluginFetch(
  request: PrivilegedFetchRequest,
  fetchImpl: Fetch,
): Promise<PrivilegedFetchResponse> {
  const url = validateHttpUrl(request.url, "fetch");
  const response = await fetchImpl(url.href, {
    method: request.method || "GET",
    headers: request.headers,
    body: request.bodyBuffer ? new Uint8Array(request.bodyBuffer) : undefined,
    redirect: "follow",
  });
  const arrayBuffer = await response.arrayBuffer();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    arrayBuffer,
  };
}
