import { readPdfAsset, type PdfAssets } from "./assets";
/** P1 requires real WASM; no dynamic JavaScript decoder fallback is shipped. */
export async function preparePdfWasm(assets: PdfAssets, compile: (bytes: Uint8Array<ArrayBuffer>) => Promise<WebAssembly.Module> = bytes => WebAssembly.compile(bytes)): Promise<void> {
  for (const filename of ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"]) await compile(readPdfAsset(assets, "wasmUrl", filename));
}
