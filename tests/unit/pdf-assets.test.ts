import { describe, expect, it } from "vitest";
const api = await import("../../src/renderer/pdf/assets").catch(() => ({})) as typeof import("../../src/renderer/pdf/assets");
const assets = { cMapUrl: { "Known.bcmap": "AP8=" }, standardFontDataUrl: {}, wasmUrl: {}, iccUrl: { "CGATS001Compat-v2-micro.icc": "AAEC" } };
describe("pinned PDF built-in assets", () => {
  it("decodes exact packaged bytes and rejects every unknown asset/path", () => {
    expect(api.readPdfAsset).toBeTypeOf("function");
    expect(api.readPdfAsset(assets, "cMapUrl", "Known.bcmap")).toEqual(new Uint8Array([0, 255]));
    for (const name of ["../Known.bcmap", "https://example.com/Known.bcmap", "__proto__", "Missing.bcmap"]) expect(() => api.readPdfAsset(assets, "cMapUrl", name)).toThrow(/asset/i);
  });
  it("offers the worker a synchronous ICC-only read with no network or arbitrary-file fallback", () => {
    expect(api.createPdfAssetRequest).toBeTypeOf("function"); const Request = api.createPdfAssetRequest(assets);
    const request = new Request(); request.open("GET", "geode-pdf-asset:/icc/CGATS001Compat-v2-micro.icc", false); request.send();
    expect(request.status).toBe(200); expect(new Uint8Array(request.response)).toEqual(new Uint8Array([0, 1, 2]));
    expect(() => new Request().open("GET", "file:///etc/passwd", false)).toThrow(/asset/i);
    expect(() => new Request().open("GET", "https://example.com", false)).toThrow(/asset/i);
    expect(() => new Request().open("POST", "geode-pdf-asset:/icc/CGATS001Compat-v2-micro.icc", false)).toThrow(/asset/i);
  });
});
it("serves async built-in asset fetches from memory and rejects real network URLs", async () => {
  expect(api.createPdfAssetFetch).toBeTypeOf("function");
  const fetch = api.createPdfAssetFetch(assets);
  expect(new Uint8Array(await (await fetch("geode-pdf-asset:/cMapUrl/Known.bcmap")).arrayBuffer())).toEqual(new Uint8Array([0,255]));
  await expect(fetch("https://example.com/Known.bcmap")).rejects.toThrow(/asset/i);
});

it("rejects noncanonical asset URIs even when a manifest contains their literal spelling", async () => {
  const names = ["Known.bcmap?x", "Known.bcmap#x", "%2e%2e", ".", "..", "%2fetc", "Known.bcmap\\tail"];
  const malicious = { cMapUrl: Object.fromEntries(names.map(name => [name, "AA=="])) };
  const fetch = api.createPdfAssetFetch(malicious);
  for (const name of names) await expect(fetch(`geode-pdf-asset:/cMapUrl/${name}`)).rejects.toThrow(/asset/i);
  for (const url of ["geode-pdf-asset://cMapUrl/Known.bcmap", "GEODE-PDF-ASSET:/cMapUrl/Known.bcmap", "geode-pdf-asset:/cMapUrl/../Known.bcmap", "file:/cMapUrl/Known.bcmap", "https://example.test/Known.bcmap"]) await expect(fetch(url)).rejects.toThrow(/asset/i);
});
