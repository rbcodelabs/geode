import type { HostHttpRequest, HostHttpResponse } from "../shared/network";

const MAX_BYTES = 100 * 1024 * 1024;

export class SenderRequests {
  private readonly owners = new Map<number, Map<string, AbortController>>();
  constructor(private readonly transport = requestOverHttp) {}
  async run(owner: number, id: string, request: HostHttpRequest): Promise<HostHttpResponse> {
    if (typeof id !== "string" || id.length > 128 || !id) throw new Error("Invalid request identity");
    const owned = this.owners.get(owner) ?? new Map<string, AbortController>(); this.owners.set(owner, owned);
    if (owned.has(id) || owned.size >= 32) throw new Error("Too many active requests");
    const controller = new AbortController(); owned.set(id, controller);
    try { return await this.transport(request, controller.signal); }
    finally { owned.delete(id); if (!owned.size && this.owners.get(owner) === owned) this.owners.delete(owner); }
  }
  cancel(owner: number, id: string): void { this.owners.get(owner)?.get(id)?.abort(); }
  cancelOwner(owner: number): void { for (const controller of this.owners.get(owner)?.values() ?? []) controller.abort(); this.owners.delete(owner); }
}

export async function requestOverHttp(request: HostHttpRequest, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<HostHttpResponse> {
  let url: URL;
  try { url = new URL(request.url); } catch { throw new Error("Invalid HTTP URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only HTTP(S) URLs without embedded credentials are supported");
  if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
  if (request.body && (typeof request.body === "string" ? Buffer.byteLength(request.body) : request.body.byteLength) > MAX_BYTES) throw new Error("Request exceeds 100 MiB limit");
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 120_000);
  try {
    let method = request.method ?? "GET"; let body = request.body; const headers = new Headers(request.headers);
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      response = await fetcher(url, { method, headers, body, signal: controller.signal, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      // Resumable uploads use 308 + Range without a redirect Location.
      if (!location) break;
      await response.body?.cancel();
      if (redirects >= 5) throw new Error("Invalid redirect");
      const next = new URL(location, url);
      if (!["http:", "https:"].includes(next.protocol) || next.username || next.password || url.protocol === "https:" && next.protocol !== "https:") throw new Error("Unsafe redirect");
      if (next.origin !== url.origin) {
        if (body !== undefined) throw new Error("Cannot redirect private request body across origins");
        for (const key of [...headers.keys()]) if (!["accept", "accept-language"].includes(key)) headers.delete(key);
      }
      if (response.status === 303 || (response.status === 301 || response.status === 302) && method.toUpperCase() === "POST") { method = "GET"; body = undefined; headers.delete("content-type"); headers.delete("content-length"); }
      url = next;
    }
    if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) { await response.body?.cancel(); throw new RangeError("Response exceeds 100 MiB limit"); }
    const chunks: Uint8Array[] = []; let length = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const result = await reader.read(); if (result.done) break;
          length += result.value.byteLength;
          if (length > MAX_BYTES) { await reader.cancel(); throw new RangeError("Response exceeds 100 MiB limit"); }
          chunks.push(result.value);
        }
      } finally { reader.releaseLock(); }
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: bytes.buffer };
  } catch (error) {
    if (controller.signal.aborted) throw new DOMException("Request cancelled or timed out", "AbortError");
    if (error instanceof RangeError) throw new Error("Response exceeds 100 MiB limit");
    // Never expose provider URLs, query credentials, response bodies, or transport diagnostics.
    throw new Error("Network request failed");
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}
