import type {
  PrivilegedRequestUrlParam,
  PrivilegedRequestUrlResponse,
} from "../shared/request-url";
import type {
  PrivilegedFetchRequest,
  PrivilegedFetchResponse,
} from "../shared/plugin-fetch";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Whole-request deadline applied to every privileged HTTP call that does not
 * ask for its own, covering the `fetch()` *and* the response body read.
 *
 * Both entry points below were previously unbounded: a connection that stalls
 * after the handshake never settles, so a caller awaiting one waits forever
 * with no error and no way to cancel. That silence is worse than a failure —
 * `SyncService.run` parks its `running` promise on exactly this await, and a
 * promise that never settles both wedges `cancel()` (which awaits it) and
 * makes every later action reject with "Sync already running or
 * disconnecting" until the app restarts.
 *
 * Five minutes is deliberately generous rather than tight. The deadline spans
 * the whole request, and a request body is uploaded inside that span, so the
 * budget has to fit the largest legitimate upload on a slow link: a 4 MiB
 * resumable chunk needs only ~110 kbps sustained to finish inside it. It is
 * still two orders of magnitude below the 40+ minute silent hang it replaces,
 * so a wedge surfaces while a user is still watching.
 *
 * A stall detector that resets on transfer progress would be gentler on a
 * genuinely slow link, but it cannot cover the half that actually wedges: the
 * Fetch API exposes no upload progress, so an upload stalling mid-body is
 * invisible to it. Getting download progress would also mean replacing
 * `response.arrayBuffer()` with a manual reader loop — changing the
 * non-timeout path for every plugin HTTP call in the app to buy coverage of
 * the direction that was not the problem. Callers with genuinely long
 * operations raise `timeout` instead of being silently killed.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/** `setTimeout` coerces anything larger to 1ms, which would fire instantly. */
const MAX_TIMEOUT_MS = 2_147_483_647;

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

/** Ignores a missing, non-numeric, non-positive, or overflowing override. */
function resolveTimeoutMs(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.min(requested, MAX_TIMEOUT_MS);
}

/**
 * Runs `send` under a whole-request deadline.
 *
 * The deadline both aborts the signal — so a real `fetch` is torn down rather
 * than left in flight holding a socket — and rejects independently of it, so a
 * transport that ignores its signal (or a body read that never settles) cannot
 * outlive the budget either. The loser of that race is pre-caught: once the
 * deadline wins, the underlying request's own abort rejection has nowhere to
 * go and would otherwise surface as an unhandled rejection.
 *
 * The message carries origin and pathname but never the query string, which
 * routinely holds upload-session keys and access tokens.
 */
async function withTimeout<T>(
  apiName: string,
  url: URL,
  timeoutMs: number,
  send: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `${apiName} timed out after ${timeoutMs}ms: ${url.origin}${url.pathname}`,
        ),
      );
    }, timeoutMs);
  });
  const work = send(controller.signal);
  work.catch(() => {});
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function performRequestUrl(
  request: PrivilegedRequestUrlParam,
  fetchImpl: Fetch,
): Promise<PrivilegedRequestUrlResponse> {
  const url = validateHttpUrl(request.url, "requestUrl");

  const headers = new Headers(request.headers);
  if (request.contentType) headers.set("Content-Type", request.contentType);
  return withTimeout("requestUrl", url, resolveTimeoutMs(request.timeout), async (signal) => {
    const response = await fetchImpl(url.href, {
      method: request.method ?? "GET",
      headers,
      body: request.body,
      redirect: "follow",
      signal,
    });
    // Inside the deadline on purpose: a response whose body never finishes
    // streaming hangs here exactly as a stalled `fetch()` hangs above.
    const arrayBuffer = await response.arrayBuffer();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    return { status: response.status, headers: responseHeaders, arrayBuffer };
  });
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
  return withTimeout("fetch", url, resolveTimeoutMs(request.timeout), async (signal) => {
    const response = await fetchImpl(url.href, {
      method: request.method || "GET",
      headers: request.headers,
      body: request.bodyBuffer ? new Uint8Array(request.bodyBuffer) : undefined,
      redirect: "follow",
      signal,
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
  });
}
