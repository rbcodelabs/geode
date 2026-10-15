import { expect, it, vi } from "vitest";
import { createElectronHost } from "../../src/renderer/host/electron-host";
it("exposes only the dedicated optional authorized PDF capability, without binary fallback", async () => {
  const readPdf = vi.fn(async () => new ArrayBuffer(7)), readBinary = vi.fn();
  const cancelPdfRead=vi.fn(async()=>{});const host = createElectronHost({ readPdf, cancelPdfRead, readBinary } as any);
  expect(host.pdfResources?.read).toBeTypeOf("function");
  await host.pdfResources!.read("/vault", "FieldGuide.pdf", "a".repeat(64));
  expect(readPdf).toHaveBeenCalledWith({ root: "/vault", path: "FieldGuide.pdf", id: "a".repeat(64) }); expect(readBinary).not.toHaveBeenCalled();
  expect(createElectronHost({ readBinary } as any).pdfResources).toBeUndefined();
});
