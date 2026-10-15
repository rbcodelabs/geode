import { describe, expect, it } from "vitest";
const api = await import("../../src/shared/pdf-viewer-protocol").catch(() => ({})) as typeof import("../../src/shared/pdf-viewer-protocol");
const bytes = new TextEncoder().encode("%PDF-1.7\nsynthetic").buffer;
const load = { kind: "load", version: 1, generation: 1, bytes, page: 1, label: "Field Guide.pdf" };
describe("private PDF viewer message schema", () => {
  it("accepts bounded bytes and view state without exposing paths or operations", () => {
    expect(api.isPdfHostMessage).toBeTypeOf("function"); expect(api.isPdfHostMessage(load)).toBe(true);
    expect(api.isPdfHostMessage({ ...load, height: 280 })).toBe(true);
    expect(api.isPdfHostMessage({ kind: "dispose", version: 1, generation: 1 })).toBe(true);
    expect(api.isPdfViewerMessage({ kind: "state", version: 1, generation: 1, page: 2, count: 3, zoom: 1.25 })).toBe(true);
    expect(api.isPdfViewerMessage({ kind: "error", version: 1, generation: 1, message: "Unsupported PDF." })).toBe(true);
    expect(api.isPdfViewerMessage({ kind: "disposed", version: 1, generation: 1 })).toBe(true);
  });
  it("rejects executable, path, network and arbitrary extra fields", () => {
    expect(api.isPdfHostMessage).toBeTypeOf("function");
    for (const key of ["path", "url", "method", "eval", "script", "__proto__"]) expect(api.isPdfHostMessage({ ...load, [key]: "untrusted" })).toBe(false);
    for (const value of [null, [], "load", { ...load, version: 2 }, { ...load, generation: 0 }, { ...load, page: 1.5 }, { ...load, height: 4000 }, { ...load, bytes: "PDF" }, { ...load, label: "X".repeat(161) }, { ...load, bytes: new ArrayBuffer(2) }]) expect(api.isPdfHostMessage(value)).toBe(false);
  });
  it("rejects stale-invalid numeric state, oversized errors and unknown events", () => {
    expect(api.isPdfViewerMessage).toBeTypeOf("function");
    for (const value of [{ kind: "state", version: 1, generation: 1, page: 4, count: 3, zoom: 1 }, { kind: "state", version: 1, generation: 1, page: 1, count: 1001, zoom: 1 }, { kind: "state", version: 1, generation: 1, page: 1, count: 1, zoom: NaN }, { kind: "error", version: 1, generation: 1, message: "x".repeat(401) }, { kind: "open", version: 1, generation: 1, url: "https://example.test" }]) expect(api.isPdfViewerMessage(value)).toBe(false);
  });
});
