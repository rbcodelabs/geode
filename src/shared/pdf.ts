export const PDF_LIMITS = { bytes: 64 * 1024 * 1024, pages: 1000, pixels: 8_000_000, minHeight: 80, maxHeight: 2000 } as const;
export interface PdfFragment { page: number; height?: number }
/** Parse only supported PDF fragment fields; callers keep the authored link unchanged. */
export function parsePdfFragment(fragment: string): PdfFragment {
  if (!fragment || fragment === "#") return { page: 1 };
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const result: PdfFragment = { page: 1 }, seen = new Set<string>();
  for (const [key, raw] of params) {
    const value = Number(raw);
    if (!["page", "height"].includes(key) || seen.has(key) || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) throw new Error("PDF fragment needs unique positive page/height integers.");
    seen.add(key);
    if (key === "height") {
      if (value < PDF_LIMITS.minHeight || value > PDF_LIMITS.maxHeight) throw new Error(`PDF fragment height must be ${PDF_LIMITS.minHeight}–${PDF_LIMITS.maxHeight}.`);
      result.height = value;
    } else result.page = value;
  }
  return result;
}
export function validatePdfPage(page: number, count: number): number {
  if (!Number.isSafeInteger(count) || count < 1 || count > PDF_LIMITS.pages) throw new Error(`This PDF exceeds the ${PDF_LIMITS.pages}-page limit or has no pages.`);
  if (!Number.isSafeInteger(page) || page < 1 || page > count) throw new Error(`PDF page must be between 1 and ${count}.`);
  return page;
}
export function pdfRenderScale(width: number, height: number, scale: number): number {
  if (![width, height, scale].every(value => Number.isFinite(value) && value > 0) || scale > 8 || width * height * scale * scale > PDF_LIMITS.pixels) throw new Error("This PDF page is too large at this zoom. Choose a smaller zoom.");
  return scale;
}
