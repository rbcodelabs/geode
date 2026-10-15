import { describe, expect, it } from "vitest";
const api = await import("../../src/shared/pdf").catch(() => ({})) as typeof import("../../src/shared/pdf");
describe("PDF authored fragments", () => {
  it("parses page/height together without changing the authored reference", () => {
    expect(api.parsePdfFragment).toBeTypeOf("function");
    expect(api.parsePdfFragment("")).toEqual({ page: 1 });
    expect(api.parsePdfFragment("#page=2&height=420")).toEqual({ page: 2, height: 420 });
    expect(api.parsePdfFragment("#height=500")).toEqual({ page: 1, height: 500 });
  });
  it.each(["#page=0", "#page=-1", "#page=1.5", "#page=9007199254740992", "#page=2&page=3", "#height=0", "#height=99999", "#page=2&unknown=x", "#Heading", "#page=1e2"])("reports unsupported/malformed fragment %s", fragment => {
    expect(() => api.parsePdfFragment(fragment)).toThrow(/PDF fragment/);
  });
  it("refuses pages outside the actual document and bounds render pixel area", () => {
    expect(api.validatePdfPage(3, 3)).toBe(3);
    expect(() => api.validatePdfPage(4, 3)).toThrow(/page/i);
    expect(() => api.validatePdfPage(1, 1001)).toThrow(/large|limit/i);
    expect(api.pdfRenderScale(600, 800, 1)).toBe(1);
    expect(() => api.pdfRenderScale(10000, 10000, 4)).toThrow(/large|limit/i);
  });
});
