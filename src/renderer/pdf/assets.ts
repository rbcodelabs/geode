export type PdfAssets = Record<string, Record<string, string>>;
export function readPdfAsset(assets: PdfAssets, kind: string, filename: string): Uint8Array<ArrayBuffer> {
  if (!Object.hasOwn(assets, kind) || typeof filename !== "string" || /[\\/\0]/.test(filename) || !Object.hasOwn(assets[kind], filename)) throw new Error("Unsupported PDF built-in asset.");
  const raw = atob(assets[kind][filename]);
  if (raw.length > 8 * 1024 * 1024) throw new Error("PDF built-in asset exceeds the resource limit.");
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
/** PDF.js's synchronous CMYK reader sees only the packaged ICC/QCMS byte assets. */
export function createPdfAssetRequest(assets: PdfAssets) {
  return class PdfAssetRequest {
    status = 0; responseType = ""; response: ArrayBuffer = new ArrayBuffer(0);
    private opened = false;
    private kind = ""; private filename = "";
    open(method: string, url: string, async: boolean): void {
      this.opened = false;
      const address = pdfAssetAddress(url);
      if (method !== "GET" || async !== false || !((address.kind === "iccUrl" && address.filename === "CGATS001Compat-v2-micro.icc") || (address.kind === "wasmUrl" && address.filename === "qcms_bg.wasm"))) throw new Error("Unsupported PDF built-in asset request.");
      this.kind = address.kind; this.filename = address.filename;
      this.opened = true;
    }
    send(_body?: unknown): void {
      if (!this.opened) throw new Error("PDF asset request is not open.");
      this.response = readPdfAsset(assets, this.kind, this.filename).buffer; this.status = 200;
    }
  };
}

function pdfAssetAddress(url: string): { kind: string; filename: string } {
  const match = /^geode-pdf-asset:\/(cMapUrl|standardFontDataUrl|wasmUrl|icc)\/([^/]+)$/.exec(url);
  if (!match || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(match[2]) || match[2] === "." || match[2] === "..") throw new Error("Unsupported PDF built-in asset URL.");
  return { kind: match[1] === "icc" ? "iccUrl" : match[1], filename: match[2] };
}
export function createPdfAssetFetch(assets: PdfAssets) {
  return async (url: string): Promise<Response> => {
    const { kind, filename } = pdfAssetAddress(url);
    return new Response(readPdfAsset(assets, kind, filename));
  };
}
