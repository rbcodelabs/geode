import { describe, expect, it, vi } from "vitest";
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

import { performPluginFetch, performRequestUrl } from "../../src/main/request-url";

describe("performRequestUrl", () => {
  it("forwards request options and returns exact response bytes", async () => {
    const responseBytes = Uint8Array.from([0, 1, 2, 255]);
    const fetchImpl = vi.fn(async () => new Response(responseBytes, {
      status: 201,
      headers: { "x-result": "created" },
    }));
    const body = Uint8Array.from([3, 4, 5]).buffer;

    const result = await performRequestUrl({
      url: "https://example.test/items",
      method: "POST",
      headers: { Authorization: "Bearer token" },
      contentType: "application/octet-stream",
      body,
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.test/items");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/octet-stream");
    expect(Array.from(new Uint8Array(init?.body as ArrayBuffer))).toEqual([3, 4, 5]);
    expect(result.status).toBe(201);
    expect(result.headers["x-result"]).toBe("created");
    expect(Array.from(new Uint8Array(result.arrayBuffer))).toEqual([0, 1, 2, 255]);
  });

  it.each(["file:///tmp/private", "ftp://example.test/file", "not a url"])(
    "rejects unsupported URL %s without making a request",
    async (url) => {
      const fetchImpl = vi.fn();
      await expect(performRequestUrl({ url }, fetchImpl)).rejects.toThrow(/http|url/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});

describe("performPluginFetch", () => {
  it("forwards method/headers/body bytes and returns exact response bytes plus statusText", async () => {
    const responseBytes = Uint8Array.from([9, 8, 7]);
    const fetchImpl = vi.fn(async () => new Response(responseBytes, {
      status: 401,
      statusText: "Unauthorized",
      headers: { "x-result": "denied" },
    }));
    const bodyBuffer = Uint8Array.from([1, 2, 3]).buffer;

    const result = await performPluginFetch({
      url: "https://api.openai.com/v1/audio/transcriptions",
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "multipart/form-data; boundary=x" },
      bodyBuffer,
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
    expect(new Headers(init?.headers).get("content-type")).toBe("multipart/form-data; boundary=x");
    expect(Array.from(init?.body as Uint8Array)).toEqual([1, 2, 3]);
    expect(result.status).toBe(401);
    expect(result.statusText).toBe("Unauthorized");
    expect(result.headers["x-result"]).toBe("denied");
    expect(Array.from(new Uint8Array(result.arrayBuffer))).toEqual([9, 8, 7]);
  });

  it("omits the body entirely for a bodyless request", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await performPluginFetch({ url: "https://example.test/x", method: "GET", headers: {} }, fetchImpl);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init?.body).toBeUndefined();
  });

  it.each(["file:///tmp/private", "ftp://example.test/file", "not a url"])(
    "rejects unsupported URL %s without making a request",
    async (url) => {
      const fetchImpl = vi.fn();
      await expect(performPluginFetch({ url, method: "GET", headers: {} }, fetchImpl)).rejects.toThrow(/http|url/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
