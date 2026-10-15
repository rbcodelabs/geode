import { PDF_VIEWER_VERSION } from "../../shared/pdf-viewer-protocol";
export const PDF_VIEWER_BUILD = "6.4.299";
export const PDF_FRAME_NODE_KEYS = ["process", "require", "geode", "electron", "ipcRenderer", "Buffer"] as const;
export interface PdfFrameInit { kind: "geode-pdf-init"; version: 1; build: string; generation: number; nonce: string }
export interface PdfFrameReady { kind: "geode-pdf-ready"; version: 1; build: string; generation: number; nonce: string; realm: Record<string, string> }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function isPdfFrameInit(value: unknown): value is PdfFrameInit {
  return record(value) && Object.keys(value).every(key => ["kind", "version", "build", "generation", "nonce"].includes(key)) && value.kind === "geode-pdf-init" && value.version === PDF_VIEWER_VERSION && value.build === PDF_VIEWER_BUILD && typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation > 0 && typeof value.nonce === "string" && /^[a-f0-9]{64}$/.test(value.nonce);
}
/** The file parent has opaque origin `null` in the verified desktop boundary.
 * Parent identity is essential: origin alone cannot identify the embedding window. */
export function createPdfFrameInitializer(parent: Window, accept: (value: { init: PdfFrameInit; port: MessagePort }) => void): (event: MessageEvent) => void {
  let initialized = false;
  return event => {
    if (initialized || event.source !== parent || event.origin !== "null" || !isPdfFrameInit(event.data) || event.ports.length !== 1 || !(event.ports[0] instanceof MessagePort)) return;
    initialized = true; accept({ init: event.data, port: event.ports[0] });
  };
}
export function pdfFrameRealm(scope: object): Record<string, string> {
  return Object.fromEntries(PDF_FRAME_NODE_KEYS.map(key => [key, typeof Reflect.get(scope, key)]));
}
export function waitForPdfFrameReady(port: MessagePort, init: PdfFrameInit, current: () => boolean, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { clearTimeout(timer); port.removeEventListener("message", message); signal?.removeEventListener("abort", cancelled); };
    const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); port.close(); reject(error); };
    const cancelled = () => { const error = new Error("PDF viewer changed or loading was cancelled."); error.name = "AbortError"; fail(error); };
    const message = (event: MessageEvent) => {
      if (!current()) { cancelled(); return; }
      const value: unknown = event.data;
      if (!record(value) || value.kind !== "geode-pdf-ready") return;
      if (!Object.keys(value).every(key => ["kind", "version", "build", "generation", "nonce", "realm"].includes(key)) || value.version !== PDF_VIEWER_VERSION || value.build !== PDF_VIEWER_BUILD || value.nonce !== init.nonce || value.generation !== init.generation || !record(value.realm) || !PDF_FRAME_NODE_KEYS.every(key => Object.hasOwn(value.realm as object, key) && (value.realm as Record<string, unknown>)[key] === "undefined")) { fail(new Error("PDF viewer identity or isolation check failed.")); return; }
      if (settled) return; settled = true; cleanup(); resolve();
    };
    const timer = setTimeout(() => fail(new Error("PDF viewer initialization timed out.")), 8000);
    port.addEventListener("message", message); port.start(); signal?.addEventListener("abort", cancelled, { once: true });
    if (!current() || signal?.aborted) cancelled();
  });
}
