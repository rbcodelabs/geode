import { nextDelay } from "../shared/backoff";
import type { HostHttpRequest, HostHttpResponse } from "../shared/network";

const MAX_BYTES = 100 * 1024 * 1024;

export interface SenderRequestsOptions {
  /** Concurrent fetches per sender; the rest wait in a FIFO queue. */
  maxActive?: number;
  /** Requests allowed to wait per sender before new ones are rejected. */
  maxQueued?: number;
  /** Consecutive transport failures to one origin before it fails fast. */
  circuitThreshold?: number;
  now?: () => number;
  random?: () => number;
}

const CIRCUIT_BACKOFF = { baseMs: 1_000, maxMs: 30_000, jitter: "equal" } as const;
const TRANSPORT_FAILURE = "Network request failed";

interface Entry { id: string; request: HostHttpRequest; controller: AbortController; started: boolean; resolve: (r: HostHttpResponse) => void; reject: (e: unknown) => void }
interface OwnerState { entries: Map<string, Entry>; queue: Entry[]; active: number }
interface Circuit { failures: number; openUntil: number }

export class SenderRequests {
  private readonly owners = new Map<number, OwnerState>();
  private readonly circuits = new Map<string, Circuit>();
  private readonly maxActive: number; private readonly maxQueued: number; private readonly threshold: number;
  private readonly now: () => number; private readonly random: () => number;
  constructor(private readonly transport = requestOverHttp, options: SenderRequestsOptions = {}) {
    this.maxActive = options.maxActive ?? 6; this.maxQueued = options.maxQueued ?? 256; this.threshold = options.circuitThreshold ?? 3;
    this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
  }
  run(owner: number, id: string, request: HostHttpRequest): Promise<HostHttpResponse> {
    if (typeof id !== "string" || id.length > 128 || !id) return Promise.reject(new Error("Invalid request identity"));
    const state = this.owners.get(owner) ?? { entries: new Map<string, Entry>(), queue: [] as Entry[], active: 0 }; this.owners.set(owner, state);
    if (state.entries.has(id)) return Promise.reject(new Error("Too many active requests"));
    if (state.active >= this.maxActive && state.queue.length >= this.maxQueued) return Promise.reject(new Error("Request queue is full"));
    return new Promise<HostHttpResponse>((resolve, reject) => {
      const entry: Entry = { id, request, controller: new AbortController(), started: false, resolve, reject };
      state.entries.set(id, entry); state.queue.push(entry); this.pump(owner, state);
    });
  }
  private pump(owner: number, state: OwnerState): void {
    while (state.active < this.maxActive && state.queue.length) {
      const entry = state.queue.shift()!; entry.started = true; state.active++;
      void this.execute(entry).then(entry.resolve, entry.reject).finally(() => {
        state.active--; state.entries.delete(entry.id);
        if (!state.entries.size && this.owners.get(owner) === state) this.owners.delete(owner); else this.pump(owner, state);
      });
    }
  }
  private async execute(entry: Entry): Promise<HostHttpResponse> {
    if (entry.controller.signal.aborted) throw new DOMException("Request cancelled", "AbortError");
    let origin: string | undefined; try { origin = new URL(entry.request.url).origin; } catch { /* the transport reports invalid URLs */ }
    const circuit = origin ? this.circuits.get(origin) : undefined;
    if (circuit && this.now() < circuit.openUntil) throw new Error(TRANSPORT_FAILURE);
    try {
      const response = await this.transport(entry.request, entry.controller.signal);
      if (origin) this.circuits.delete(origin);
      return response;
    } catch (error) {
      // Only transport-level failures trip the circuit; aborts, validation and size errors say nothing about the origin.
      if (origin && error instanceof Error && error.name !== "AbortError" && error.message === TRANSPORT_FAILURE) {
        const failures = (circuit?.failures ?? 0) + 1;
        const openUntil = failures >= this.threshold ? this.now() + nextDelay(failures - this.threshold, { ...CIRCUIT_BACKOFF, random: this.random }) : 0;
        this.circuits.set(origin, { failures, openUntil });
      }
      throw error;
    }
  }
  cancel(owner: number, id: string): void { const state = this.owners.get(owner); const entry = state?.entries.get(id); if (state && entry) this.abort(state, entry); }
  cancelOwner(owner: number): void { const state = this.owners.get(owner); if (state) for (const entry of [...state.entries.values()]) this.abort(state, entry); }
  private abort(state: OwnerState, entry: Entry): void {
    entry.controller.abort();
    if (entry.started) return;
    // Never started: settle now and drop it so it cannot fetch.
    state.queue.splice(state.queue.indexOf(entry), 1); state.entries.delete(entry.id);
    entry.reject(new DOMException("Request cancelled", "AbortError"));
  }
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
