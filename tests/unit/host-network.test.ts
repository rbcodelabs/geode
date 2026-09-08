import { expect, it, vi } from "vitest";
import { requestOverHttp, SenderRequests } from "../../src/main/network";

it("only lets the owning renderer cancel its active request", async () => {
  const signals: AbortSignal[] = [];
  const registry = new SenderRequests(async (_request, signal) => { signals.push(signal!); return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")))); });
  const pending = registry.run(1, "request", { url: "https://example.invalid" });
  const check = expect(pending).rejects.toThrow("cancelled");
  registry.cancel(2, "request"); expect(signals[0].aborted).toBe(false);
  registry.cancelOwner(1); await check; expect(signals[0].aborted).toBe(true);
});

it("does not lose a new ownership map when an old cancelled request settles", async () => {
  const signals: AbortSignal[] = [];
  const registry = new SenderRequests(async (_request, signal) => { signals.push(signal!); return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")))); });
  const old = registry.run(1, "old", { url: "https://example.invalid" }); const oldCheck = expect(old).rejects.toThrow("cancelled"); registry.cancelOwner(1);
  const fresh = registry.run(1, "fresh", { url: "https://example.invalid" }); const freshCheck = expect(fresh).rejects.toThrow("cancelled");
  await oldCheck; registry.cancel(1, "fresh"); expect(signals[1].aborted).toBe(true); await freshCheck;
});

it("validates redirects and strips cross-origin credentials", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.invalid/blob" } })).mockResolvedValueOnce(new Response("ok"));
  await requestOverHttp({ url: "https://example.invalid/blob", headers: { Authorization: "private", Cookie: "private", "X-API-Key": "private" } }, undefined, fetcher);
  const redirected = fetcher.mock.calls[1][1]; expect(redirected.redirect).toBe("manual"); expect(new Headers(redirected.headers).has("authorization")).toBe(false); expect(new Headers(redirected.headers).has("cookie")).toBe(false);
  expect(new Headers(redirected.headers).has("x-api-key")).toBe(false);
});

it("rejects HTTPS downgrades before sending redirected credentials", async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 307, headers: { location: "http://other.invalid" } }));
  await expect(requestOverHttp({ url: "https://example.invalid" }, undefined, fetcher as typeof fetch)).rejects.toThrow("Network request failed"); expect(fetcher).toHaveBeenCalledOnce();
});

it("cancels a chunked response that grows beyond the byte limit", async () => {
  const cancel = vi.fn(); let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(50 * 1024 * 1024)); chunks++; }, cancel });
  const fetcher = vi.fn(async () => new Response(stream));
  await expect(requestOverHttp({ url: "https://example.invalid" }, undefined, fetcher as typeof fetch)).rejects.toThrow(/100 MiB/); expect(cancel).toHaveBeenCalledOnce(); expect(chunks).toBeLessThanOrEqual(4);
});

it("aborts a stalled request at the bounded timeout", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn((_url, options) => new Promise<Response>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("secret detail")))));
    const pending = requestOverHttp({ url: "https://example.invalid" }, undefined, fetcher as typeof fetch);
    const check = expect(pending).rejects.toMatchObject({ name: "AbortError" }); await vi.advanceTimersByTimeAsync(120_000); await check;
  } finally { vi.useRealTimers(); }
});

it("preserves non-success status and binary body without renderer fetch", async () => {
  const fetcher = vi.fn(async () => new Response(new Uint8Array([0, 255, 7]), { status: 409, headers: { "X-Probe": "yes" } }));
  const result = await requestOverHttp({ url: "https://example.invalid/blob", headers: { Authorization: "Bearer private" } }, undefined, fetcher as typeof fetch);
  expect(result.status).toBe(409); expect([...new Uint8Array(result.body)]).toEqual([0, 255, 7]); expect(result.headers["x-probe"]).toBe("yes");
});

it("redacts URL, credentials and underlying errors from network failures", async () => {
  const fetcher = vi.fn(async () => { throw new Error("https://example.invalid/?access_token=private"); });
  await expect(requestOverHttp({ url: "https://example.invalid/?access_token=private" }, undefined, fetcher as typeof fetch)).rejects.toThrow(/^Network request failed$/);
});

it("rejects non-HTTP protocols without invoking the transport", async () => {
  const fetcher = vi.fn(); await expect(requestOverHttp({ url: "file:///private/file" }, undefined, fetcher)).rejects.toThrow(/HTTP/); expect(fetcher).not.toHaveBeenCalled();
});

it("does not issue an already cancelled request", async () => {
  const controller = new AbortController(); controller.abort(); const fetcher = vi.fn();
  await expect(requestOverHttp({ url: "https://example.invalid" }, controller.signal, fetcher)).rejects.toMatchObject({ name: "AbortError" }); expect(fetcher).not.toHaveBeenCalled();
});

it("rejects oversized response headers before consuming a body", async () => {
  const fetcher = vi.fn(async () => new Response("", { headers: { "content-length": String(100 * 1024 * 1024 + 1) } }));
  await expect(requestOverHttp({ url: "https://example.invalid" }, undefined, fetcher as typeof fetch)).rejects.toThrow(/100 MiB/);
});
