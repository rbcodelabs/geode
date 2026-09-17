import { afterEach, describe, expect, it, vi } from "vitest";
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

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  performPluginFetch,
  performRequestUrl,
} from "../../src/main/request-url";

/** A transport that accepts the request and then never answers. */
function stalledFetch() {
  return vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}));
}

/** Headers arrive, then the body never finishes streaming. */
function stalledBodyFetch() {
  return vi.fn(async () => ({
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
  }) as unknown as Response);
}

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

  describe("timeout", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects a transport that never responds, naming the URL without its query string", async () => {
      vi.useFakeTimers();
      const fetchImpl = stalledFetch();
      const result = performRequestUrl(
        { url: "https://drive.example/upload/files?uploadType=multipart&token=secret" },
        fetchImpl,
      );
      const settled = vi.fn();
      result.then(settled, settled);

      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      const error = await result.catch((e: unknown) => e as Error);
      // Exact, so an added query string (upload-session keys, access tokens)
      // would fail this rather than slip through a substring match.
      expect(error.message).toBe(
        `requestUrl timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms: https://drive.example/upload/files`,
      );
    });

    it("rejects a response whose body never finishes streaming", async () => {
      vi.useFakeTimers();
      const fetchImpl = stalledBodyFetch();
      const result = performRequestUrl({ url: "https://drive.example/files/abc" }, fetchImpl);
      const settled = vi.fn();
      result.then(settled, settled);

      // The transport answered; only arrayBuffer() is outstanding.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
      const error = await result.catch((e: unknown) => e as Error);
      expect(error.message).toBe(
        `requestUrl timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms: https://drive.example/files/abc`,
      );
    });

    it("aborts the signal it handed the transport, so a real fetch is torn down", async () => {
      vi.useFakeTimers();
      const fetchImpl = stalledFetch();
      const result = performRequestUrl({ url: "https://drive.example/files" }, fetchImpl);
      result.catch(() => {});

      const signal = fetchImpl.mock.calls[0][1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
      expect(signal!.aborted).toBe(true);
    });

    it("honors a caller-supplied timeout instead of the default", async () => {
      vi.useFakeTimers();
      const fetchImpl = stalledFetch();
      const result = performRequestUrl({ url: "https://drive.example/files", timeout: 25 }, fetchImpl);
      const settled = vi.fn();
      result.then(settled, settled);

      await vi.advanceTimersByTimeAsync(24);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      const error = await result.catch((e: unknown) => e as Error);
      expect(error.message).toBe("requestUrl timed out after 25ms: https://drive.example/files");
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "30" as unknown as number])(
      "falls back to the default for an unusable timeout override %p",
      async (timeout) => {
        vi.useFakeTimers();
        const fetchImpl = stalledFetch();
        const result = performRequestUrl({ url: "https://drive.example/files", timeout }, fetchImpl);
        const settled = vi.fn();
        result.then(settled, settled);

        await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        const error = await result.catch((e: unknown) => e as Error);
        expect(error.message).toContain(`timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`);
      },
    );

    it("leaves a fast request untouched and clears its timer", async () => {
      vi.useFakeTimers();
      const fetchImpl = vi.fn(async () => new Response(Uint8Array.from([7]), {
        status: 200,
        headers: { "x-ok": "1" },
      }));

      const result = await performRequestUrl({ url: "https://drive.example/files" }, fetchImpl);

      expect(result.status).toBe(200);
      expect(result.headers["x-ok"]).toBe("1");
      expect(Array.from(new Uint8Array(result.arrayBuffer))).toEqual([7]);
      expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not leave a stray unhandled rejection behind when the abort rejects late", async () => {
      const unhandled: unknown[] = [];
      const capture = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", capture);
      try {
        // Real timers and a 5ms budget: the point is to let the process
        // actually reach the tick where an unhandled rejection is reported.
        const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }));

        await expect(
          performRequestUrl({ url: "https://drive.example/files", timeout: 5 }, fetchImpl),
        ).rejects.toThrow(/timed out after 5ms/);

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", capture);
      }
    });
  });
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

  describe("timeout", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects a transport that never responds and aborts its signal", async () => {
      vi.useFakeTimers();
      const fetchImpl = stalledFetch();
      const result = performPluginFetch(
        { url: "https://api.example/v1/transcriptions?key=secret", method: "POST", headers: {} },
        fetchImpl,
      );
      result.catch(() => {});
      const signal = fetchImpl.mock.calls[0][1]?.signal;

      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

      const error = await result.catch((e: unknown) => e as Error);
      expect(error.message).toBe(
        `fetch timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms: https://api.example/v1/transcriptions`,
      );
      expect(signal!.aborted).toBe(true);
    });

    it("rejects a response whose body never finishes streaming", async () => {
      vi.useFakeTimers();
      const result = performPluginFetch(
        { url: "https://api.example/v1/blob", method: "GET", headers: {} },
        stalledBodyFetch(),
      );
      result.catch(() => {});

      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

      const error = await result.catch((e: unknown) => e as Error);
      expect(error.message).toBe(
        `fetch timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms: https://api.example/v1/blob`,
      );
    });

    it("honors a caller-supplied timeout instead of the default", async () => {
      vi.useFakeTimers();
      const result = performPluginFetch(
        { url: "https://api.example/v1/slow", method: "GET", headers: {}, timeout: 25 },
        stalledFetch(),
      );
      const settled = vi.fn();
      result.then(settled, settled);

      await vi.advanceTimersByTimeAsync(24);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      const error = await result.catch((e: unknown) => e as Error);
      expect(error.message).toBe("fetch timed out after 25ms: https://api.example/v1/slow");
    });

    it("leaves a fast request untouched and clears its timer", async () => {
      vi.useFakeTimers();
      const fetchImpl = vi.fn(async () => new Response(Uint8Array.from([5]), {
        status: 202,
        statusText: "Accepted",
      }));

      const result = await performPluginFetch(
        { url: "https://api.example/v1/ok", method: "GET", headers: {} },
        fetchImpl,
      );

      expect(result.status).toBe(202);
      expect(result.statusText).toBe("Accepted");
      expect(Array.from(new Uint8Array(result.arrayBuffer))).toEqual([5]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
