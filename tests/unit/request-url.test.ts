import { expect, it, vi } from "vitest";
import { installHostServices } from "../../src/renderer/host/registry";
import { requestUrl } from "../../src/renderer/api/obsidian";
import { requestOverHttp } from "../../src/main/network";

it("returns resumable 308 responses without a redirect location", async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 308, headers: { Range: "bytes=0-4194303" } }));
  installHostServices({ network: { request: (request: never) => requestOverHttp(request, undefined, fetcher) } } as never);
  const response = await requestUrl({ url: "https://example.invalid/upload", method: "PUT", throw: false });
  expect(response.status).toBe(308); expect(response.headers.range).toBe("bytes=0-4194303"); expect(fetcher).toHaveBeenCalledOnce();
});

it("does not decode or parse binary responses until requested", async () => {
  const body = new TextEncoder().encode('{"ok":true}').buffer;
  installHostServices({ network: { request: async () => ({ status: 200, headers: {}, body }) } } as never);
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  try {
    const response = await requestUrl("https://example.invalid/blob");
    expect(response.arrayBuffer).toBe(body); expect(decode).not.toHaveBeenCalled();
    expect(response.json).toEqual({ ok: true }); expect(response.text).toBe('{"ok":true}'); expect(decode).toHaveBeenCalledOnce();
  } finally { decode.mockRestore(); }
});

it("routes desktop requestUrl through the host with binary fidelity and throw:false", async () => {
  const request = vi.fn(async () => ({ status: 403, headers: { "retry-after": "2" }, body: new TextEncoder().encode('{"error":"denied"}').buffer }));
  installHostServices({ network: { request } } as never);
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Renderer networking forbidden"));
  try {
    const response = await requestUrl({ url: "https://example.invalid", throw: false });
    expect(response.status).toBe(403); expect(response.json).toEqual({ error: "denied" }); expect(request).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); }
});

it("redacts provider URL query strings from HTTP errors", async () => {
  installHostServices({ network: { request: async () => ({ status: 401, headers: {}, body: new ArrayBuffer(0) }) } } as never);
  await expect(requestUrl({ url: "https://example.invalid/?secret=private" })).rejects.toThrow(/^requestUrl failed: 401$/);
});
