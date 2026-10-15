import { PDF_LIMITS } from "./pdf";
export const PDF_VIEWER_VERSION = 1;
export const PDF_VIEWER_ORIGIN = "geode-pdf://viewer";
export const PDF_VIEWER_URL = `${PDF_VIEWER_ORIGIN}/index.html`;
interface Envelope { version: 1; generation: number }
export type PdfHostMessage = Envelope & ({ kind: "load"; bytes: ArrayBuffer; page: number; height?: number; label: string } | { kind: "dispose" });
export type PdfViewerMessage = Envelope & ({ kind: "state"; page: number; count: number; zoom: number } | { kind: "error"; message: string } | { kind: "disposed" });
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
function envelope(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Reflect.get(value, "version") === PDF_VIEWER_VERSION && integer(Reflect.get(value, "generation"));
}
function only(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => ["kind", "version", "generation", ...keys].includes(key)); }
export function isPdfHostMessage(value: unknown): value is PdfHostMessage {
  if (!envelope(value)) return false;
  if (value.kind === "dispose") return only(value, []);
  if (value.kind !== "load" || !only(value, ["bytes", "page", "height", "label"])) return false;
  return value.bytes instanceof ArrayBuffer && value.bytes.byteLength >= 5 && value.bytes.byteLength <= PDF_LIMITS.bytes && integer(value.page, PDF_LIMITS.pages) && typeof value.label === "string" && value.label.length <= 160 && (value.height === undefined || (integer(value.height, PDF_LIMITS.maxHeight) && value.height >= PDF_LIMITS.minHeight));
}
export function isPdfViewerMessage(value: unknown): value is PdfViewerMessage {
  if (!envelope(value)) return false;
  if (value.kind === "disposed") return only(value, []);
  if (value.kind === "error") return only(value, ["message"]) && typeof value.message === "string" && value.message.length <= 400;
  return value.kind === "state" && only(value, ["page", "count", "zoom"]) && integer(value.count, PDF_LIMITS.pages) && integer(value.page, value.count) && typeof value.zoom === "number" && Number.isFinite(value.zoom) && value.zoom > 0 && value.zoom <= 8;
}
