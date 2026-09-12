import { describe, expect, it, vi } from "vitest";
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
