import { expect, it, vi } from "vitest";
const api = await import("../../src/renderer/pdf/wasm").catch(() => ({})) as typeof import("../../src/renderer/pdf/wasm");
const valid = Buffer.from([0,97,115,109,1,0,0,0]).toString("base64");
const assets = { wasmUrl: { "jbig2.wasm": valid, "openjpeg.wasm": valid, "qcms_bg.wasm": valid } };
it("proves all required packaged codecs compile before announcing worker readiness", async () => {
  expect(api.preparePdfWasm).toBeTypeOf("function");
  const compile = vi.fn((bytes: Uint8Array<ArrayBuffer>) => WebAssembly.compile(bytes));
  await api.preparePdfWasm(assets, compile); expect(compile).toHaveBeenCalledTimes(3);
});
it("fails closed for missing, corrupt, blocked or unavailable WASM", async () => {
  expect(api.preparePdfWasm).toBeTypeOf("function");
  await expect(api.preparePdfWasm({ wasmUrl: {} })).rejects.toThrow(/PDF|asset/i);
  await expect(api.preparePdfWasm({ wasmUrl: { ...assets.wasmUrl, "jbig2.wasm": "AAAA" } })).rejects.toThrow();
  await expect(api.preparePdfWasm(assets, async () => { throw new Error("WASM blocked"); })).rejects.toThrow(/WASM blocked/);
});
