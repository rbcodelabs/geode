import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { PluginArtifactTransport } from "../../shared/network";
import { base64ToBytes } from "./base64";

const CONNECT_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 30_000;

function assertHttps(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid download URL"); }
  if (parsed.protocol !== "https:") throw new Error("Only https downloads are allowed");
}

async function readWithin(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Download is too large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Download is too large");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return combined;
}

/**
 * Native (iOS/Android) uses CapacitorHttp: github.com release downloads
 * redirect to release-assets.githubusercontent.com, which sends no CORS
 * headers, so a WebView `fetch` cannot read them. Plain `fetch` is used on the
 * web build, where the catalog (CORS `*`) is reachable and release downloads
 * are expected to fail honestly rather than be proxied.
 */
export function createMobileArtifactTransport(): PluginArtifactTransport {
  return async (url, { maxBytes, accept }) => {
    assertHttps(url);
    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.get({
        url,
        headers: accept ? { Accept: accept } : {},
        responseType: "arraybuffer",
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: READ_TIMEOUT_MS,
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`Download failed (HTTP ${response.status})`);
      const data: unknown = response.data;
      // Capacitor returns binary response bodies base64-encoded.
      if (typeof data === "string") {
        if (Math.ceil(data.length * 0.75) > maxBytes + 3) throw new Error("Download is too large");
        const bytes = base64ToBytes(data);
        if (bytes.byteLength > maxBytes) throw new Error("Download is too large");
        return bytes;
      }
      if (data instanceof ArrayBuffer) {
        if (data.byteLength > maxBytes) throw new Error("Download is too large");
        return new Uint8Array(data);
      }
      throw new Error("Download returned an unsupported body");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: accept ? { Accept: accept } : {},
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Download is too large");
      return await readWithin(response, maxBytes);
    } finally {
      clearTimeout(timer);
    }
  };
}
