import { createPdfAssetRequest, createPdfAssetFetch, type PdfAssets } from "./assets";
declare const __GEODE_PDF_ASSETS__: PdfAssets;
import { preparePdfWasm } from "./wasm";
import { version } from "pdfjs-dist/package.json";
import { PDF_REALM_KEYS, pdfWorkerRealm } from "./verified-worker";

// This entry is built WITHOUT the display bundle's process=undefined define:
// the handshake must inspect the actual worker globals, not compiled constants.
const realm = pdfWorkerRealm(globalThis);
if (PDF_REALM_KEYS.some(key => realm[key] !== "undefined")) throw new Error("PDF worker requires an unprivileged worker realm.");
// Data arrives over the verified port; built-in assets are supplied by the
// worker's pinned allowlist factory, so the parser requests no real network assets. These operational
// allowlists are not a substitute for the worker response CSP.
Object.defineProperty(globalThis, "fetch", { value: createPdfAssetFetch(__GEODE_PDF_ASSETS__), writable: false });
Object.defineProperty(globalThis, "XMLHttpRequest", { value: createPdfAssetRequest(__GEODE_PDF_ASSETS__), writable: false });
for (const key of ["WebSocket", "EventSource"]) Object.defineProperty(globalThis, key, { value: undefined, writable: false });
await preparePdfWasm(__GEODE_PDF_ASSETS__);
await import("pdfjs-dist/build/pdf.worker.mjs");
postMessage({ kind: "geode-pdf-worker-ready", version, realm });
