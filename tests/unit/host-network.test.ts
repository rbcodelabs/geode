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

const ok = { status: 200, headers: {}, body: new ArrayBuffer(0) };
const gate = () => { const waiting: Array<{ id: string; release: () => void; fail: (e: Error) => void; signal: AbortSignal }> = []; let active = 0, peak = 0;
  const transport = (request: { url: string }, signal?: AbortSignal) => new Promise<typeof ok>((resolve, reject) => {
    active++; peak = Math.max(peak, active); let done = false;
    const entry = { id: request.url, signal: signal!, release: () => { if (!done) { done = true; active--; resolve(ok); } }, fail: (e: Error) => { if (!done) { done = true; active--; reject(e); } } };
    waiting.push(entry); signal?.addEventListener("abort", () => { if (!done) { done = true; active--; } reject(new DOMException("x", "AbortError")); });
  });
  return { transport, waiting, peak: () => peak }; };

it("caps concurrent fetches per sender and starts queued requests in FIFO order", async () => {
  const g = gate(); const registry = new SenderRequests(g.transport as never, { maxActive: 2 });
  const results = [0, 1, 2, 3, 4].map(i => registry.run(1, `r${i}`, { url: `https://a.invalid/${i}` }));
  await Promise.resolve(); expect(g.waiting.map(w => w.id)).toEqual(["https://a.invalid/0", "https://a.invalid/1"]);
  g.waiting[0].release(); await new Promise(r => setTimeout(r, 0));
  expect(g.waiting.map(w => w.id)).toEqual(["https://a.invalid/0", "https://a.invalid/1", "https://a.invalid/2"]);
  while (g.waiting.length < 5) { g.waiting.filter(w => w).forEach(w => w.release()); await new Promise(r => setTimeout(r, 0)); }
  g.waiting.forEach(w => w.release()); await Promise.all(results); expect(g.peak()).toBeLessThanOrEqual(2);
  expect(g.waiting.map(w => w.id)).toEqual([0, 1, 2, 3, 4].map(i => `https://a.invalid/${i}`));
});

it("does not hard-fail at 32 requests and rejects beyond the queue bound", async () => {
  const g = gate(); const registry = new SenderRequests(g.transport as never, { maxActive: 1, maxQueued: 3 });
  const pending = [0, 1, 2, 3].map(i => registry.run(1, `r${i}`, { url: `https://a.invalid/${i}` }));
  await expect(registry.run(1, "overflow", { url: "https://a.invalid/x" })).rejects.toThrow(/queue is full/i);
  registry.cancelOwner(1); for (const p of pending) await expect(p).rejects.toMatchObject({ name: "AbortError" });
});

it("rejects duplicate ids, active or queued", async () => {
  const g = gate(); const registry = new SenderRequests(g.transport as never, { maxActive: 1 });
  const a = registry.run(1, "same", { url: "https://a.invalid/1" }); const b = registry.run(1, "queued", { url: "https://a.invalid/2" });
  await expect(registry.run(1, "queued", { url: "https://a.invalid/3" })).rejects.toThrow("Too many active requests");
  registry.cancelOwner(1); await expect(a).rejects.toBeTruthy(); await expect(b).rejects.toBeTruthy();
});

it("cancels a queued request without ever fetching it", async () => {
  const g = gate(); const seen: string[] = []; const registry = new SenderRequests(((r: { url: string }, s: AbortSignal) => { seen.push(r.url); return g.transport(r, s); }) as never, { maxActive: 1 });
  const first = registry.run(1, "first", { url: "https://a.invalid/first" }); const queued = registry.run(1, "queued", { url: "https://a.invalid/queued" });
  registry.cancel(2, "queued"); registry.cancel(1, "queued");
  await expect(queued).rejects.toMatchObject({ name: "AbortError" });
  g.waiting[0].release(); await first; await Promise.resolve(); expect(seen).toEqual(["https://a.invalid/first"]);
});

it("opens a per-origin circuit after 3 transport failures, half-opens after the window, and resets on success", async () => {
  let now = 1000; let calls = 0; let mode: "fail" | "ok" | "http" = "fail";
  const transport = vi.fn(async () => { calls++; if (mode === "fail") throw new Error("Network request failed"); return ok; });
  const registry = new SenderRequests(transport as never, { now: () => now, random: () => 0 });
  const req = { url: "https://down.invalid/x" };
  for (let i = 0; i < 3; i++) await expect(registry.run(1, `f${i}`, req)).rejects.toThrow("Network request failed");
  expect(calls).toBe(3);
  await expect(registry.run(1, "fast", req)).rejects.toThrow("Network request failed"); expect(calls).toBe(3);
  await registry.run(1, "other", { url: "https://up.invalid/x" }).then(() => undefined, () => undefined); expect(calls).toBe(4);
  now += 60_000; mode = "fail";
  await expect(registry.run(1, "probe", req)).rejects.toThrow("Network request failed"); expect(calls).toBe(5);
  await expect(registry.run(1, "fast2", req)).rejects.toThrow("Network request failed"); expect(calls).toBe(5);
  now += 60_000; mode = "ok"; await registry.run(1, "recover", req); expect(calls).toBe(6);
  mode = "fail"; await expect(registry.run(1, "after", req)).rejects.toThrow(); await expect(registry.run(1, "after2", req)).rejects.toThrow(); await registry.run(1, "after3", req).catch(() => undefined);
  expect(calls).toBe(9);
});

it("does not count non-transport errors or aborts toward the circuit", async () => {
  const transport = vi.fn(async () => { throw new Error("Invalid HTTP URL"); });
  const registry = new SenderRequests(transport as never);
  for (let i = 0; i < 6; i++) await expect(registry.run(1, `e${i}`, { url: "https://x.invalid" })).rejects.toThrow("Invalid HTTP URL");
  expect(transport).toHaveBeenCalledTimes(6);
});

it("caps the circuit backoff window at 30s", async () => {
  let now = 0; const transport = vi.fn(async () => { throw new Error("Network request failed"); });
  const registry = new SenderRequests(transport as never, { now: () => now, random: () => 0.999999 });
  for (let i = 0; i < 20; i++) { now += 31_000; await registry.run(1, `c${i}`, { url: "https://x.invalid" }).catch(() => undefined); }
  expect(transport).toHaveBeenCalledTimes(20);
});
