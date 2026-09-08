import { describe, expect, it, vi } from "vitest";
import { performRequestUrl } from "../../src/main/request-url";

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
