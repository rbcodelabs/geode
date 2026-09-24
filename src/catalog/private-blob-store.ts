import * as blob from "@vercel/blob";
import type { ObjectStore } from "./object-store";

type BlobSdk = Pick<typeof blob, "put" | "get" | "del" | "list">;
export interface PrivateBlobOptions {
  readonly prefix: string;
  /** Explicit token prevents accidental fallback to another attached store. Never logged. */
  readonly token: string;
  readonly maxObjectBytes: number;
  readonly maxReadBytes: number;
  /** Conservative wire-upload budget including the pinned SDK's retry allowance. */
  readonly maxUploadedBytes: number;
  readonly maxOperations: number;
  readonly timeoutMs: number;
  /** Must durably record the exact physical key BEFORE its first possible write. */
  readonly beforeWrite: (pathname: string) => Promise<void>;
  readonly sdk?: BlobSdk;
}
export interface BlobMetrics {
  calls: number; reservedAttempts: number; readBytes: number; uploadedBytes: number;
  reservedUploadBytes: number; failures: number;
  /** Response counts only; no header values, object keys or contents are recorded. */
  encodedResponses: number; unknownLengthResponses: number;
}
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/objects\/[a-f0-9]{64}$/;
// @vercel/blob 2.8.0 defaults to ten retries. Reserve worst case, not claimed billing.
const ATTEMPTS = 11;
export function createPrivateBlobStore(options: PrivateBlobOptions): ObjectStore & { metrics(): Readonly<BlobMetrics> } {
  if (!/^[a-z][a-z0-9_]{0,62}\/$/.test(options.prefix) || !options.token) throw new Error("Invalid private Blob configuration");
  for (const n of [options.maxObjectBytes, options.maxReadBytes, options.maxUploadedBytes, options.maxOperations, options.timeoutMs]) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Invalid Blob limit");
  }
  if (options.timeoutMs > 60_000) throw new Error("Invalid Blob timeout");
  const sdk = options.sdk ?? blob;
  const usage: BlobMetrics = { calls: 0, reservedAttempts: 0, readBytes: 0, uploadedBytes: 0, reservedUploadBytes: 0, failures: 0, encodedResponses: 0, unknownLengthResponses: 0 };
  let reservedReadBytes = 0;
  function pathname(key: string) {
    if (!KEY.test(key)) throw new Error("Invalid object key");
    return options.prefix + key;
  }
  function reserve(uploadBytes = 0) {
    const configuredRetries = process.env.VERCEL_BLOB_RETRIES;
    if (configuredRetries !== undefined && !/^(?:[0-9]|10)$/.test(configuredRetries)) throw new Error("Unbounded Blob retries refused");
    if (usage.reservedAttempts + ATTEMPTS > options.maxOperations || usage.reservedUploadBytes + uploadBytes * ATTEMPTS > options.maxUploadedBytes) throw new Error("Blob budget exceeded");
    usage.calls++; usage.reservedAttempts += ATTEMPTS; usage.reservedUploadBytes += uploadBytes * ATTEMPTS;
  }
  async function request<T>(fn: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([fn(controller.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Blob operation timed out")); }, options.timeoutMs);
      })]);
    } catch { usage.failures++; throw new Error("Private Blob operation failed"); }
    finally { clearTimeout(timer); }
  }
  return {
    metrics: () => ({ ...usage }),
    async put(key, bytes, contentType) {
      const path = pathname(key);
      if (bytes.byteLength > options.maxObjectBytes) throw new Error("Blob size exceeds limit");
      reserve(bytes.byteLength);
      const result = await request(async abortSignal => {
        await options.beforeWrite(path);
        if (abortSignal.aborted) throw new Error("Blob inventory timed out");
        return sdk.put(path, Buffer.from(bytes), {
        token: options.token, abortSignal, access: "private", addRandomSuffix: false, allowOverwrite: false, contentType,
        });
      });
      if (result.pathname !== path) throw new Error("Blob pathname differs from requested key");
      usage.uploadedBytes += bytes.byteLength;
      return key;
    },
    async get(key) {
      const path = pathname(key); reserve();
      // Reserve a whole bounded object before awaiting: concurrent reads cannot overspend.
      if (reservedReadBytes + options.maxObjectBytes > options.maxReadBytes) throw new Error("Blob read budget exceeded");
      reservedReadBytes += options.maxObjectBytes;
      let observed = 0;
      let completed = false;
      try {
        return await request(async abortSignal => {
          const result = await sdk.get(path, { token: options.token, abortSignal, access: "private", useCache: false });
          if (result === null) { completed = true; return null; }
          if (result.statusCode !== 200) throw new Error("Blob response status refused");
          const reader = result.stream.getReader();
          const abort = () => { void reader.cancel().catch(() => undefined); };
          abortSignal.addEventListener("abort", abort, { once: true });
          try {
            if (abortSignal.aborted) throw new Error("Blob response arrived after timeout");
            if (result.blob.pathname !== path) throw new Error("Blob pathname differs from requested key");
            // SDK 2.8.0 derives blob.size from HTTP Content-Length (or zero
            // when absent). fetch decodes compressed bodies but retains those
            // wire headers, so only an explicit identity length describes the
            // bytes this reader receives. DSQL metadata + digest verification
            // above this boundary establish the actual object's integrity.
            const encoding = result.headers.get("content-encoding")?.trim().toLowerCase();
            const lengthHeader = result.headers.get("content-length");
            if (encoding && encoding !== "identity") usage.encodedResponses++;
            if (lengthHeader === null) usage.unknownLengthResponses++;
            const identityLength = (!encoding || encoding === "identity") && lengthHeader !== null;
            const expectedLength = identityLength ? Number(lengthHeader) : null;
            if (identityLength && (!/^[0-9]+$/.test(lengthHeader!) || !Number.isSafeInteger(expectedLength)
              || expectedLength! < 0 || expectedLength! > options.maxObjectBytes)) throw new Error("Blob size exceeds limit");
            const parts: Uint8Array[] = [];
            while (true) {
              const chunk = await reader.read();
              if (abortSignal.aborted) throw new Error("Blob read aborted");
              if (chunk.done) break;
              observed += chunk.value.byteLength;
              if (observed > options.maxObjectBytes || (expectedLength !== null && observed > expectedLength)) throw new Error("Blob size differs from metadata");
              parts.push(chunk.value);
            }
            if (expectedLength !== null && observed !== expectedLength) throw new Error("Blob size differs from metadata");
            const bytes = Buffer.concat(parts, observed);
            return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          } finally { abortSignal.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); completed = true; }
        });
      } finally {
        usage.readBytes += observed;
        reservedReadBytes += (completed ? observed : Math.max(observed, options.maxObjectBytes)) - options.maxObjectBytes;
      }
    },
    async delete(key) {
      const path = pathname(key); reserve();
      await request(abortSignal => sdk.del(path, { token: options.token, abortSignal }));
    },
    async list(keyPrefix) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/$/.test(keyPrefix)) throw new Error("Invalid list prefix");
      reserve();
      const result = await request(abortSignal => sdk.list({ token: options.token, abortSignal, prefix: options.prefix + keyPrefix, limit: 1000 }));
      if (result.hasMore) throw new Error("Blob listing exceeds bounded page");
      return result.blobs.map(item => {
        const key = item.pathname.slice(options.prefix.length);
        if (!item.pathname.startsWith(options.prefix + keyPrefix) || pathname(key) !== item.pathname) throw new Error("Blob listing pathname outside scope");
        return key;
      });
    },
  };
}
