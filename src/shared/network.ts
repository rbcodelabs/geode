export interface HostHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}
export interface HostHttpResponse { status: number; headers: Record<string, string>; body: ArrayBuffer; }

/**
 * Bounded GET of a public https URL returning raw bytes. Host-provided on the
 * mobile runtime so the native stack (which is not subject to WebView CORS) can
 * serve supported-plugin catalog/artifact downloads. Callers verify integrity
 * themselves; the transport is not trusted.
 */
export type PluginArtifactTransport = (
  url: string,
  options: { maxBytes: number; accept?: string },
) => Promise<Uint8Array>;
