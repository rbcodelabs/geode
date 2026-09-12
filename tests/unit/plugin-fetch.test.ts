import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginFetch } from "../../src/renderer/plugin-fetch";
import { instantiatePluginClass } from "../../src/renderer/plugin-manager";
import type { PrivilegedFetchResponse } from "../../src/shared/plugin-fetch";

function jsonResponse(body: unknown, overrides: Partial<PrivilegedFetchResponse> = {}): PrivilegedFetchResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    arrayBuffer: new TextEncoder().encode(JSON.stringify(body)).buffer,
    ...overrides,
  };
}

afterEach(() => {
  delete (globalThis as any).window;
});

describe("pluginFetch", () => {
  it("delegates an absolute http(s) request to window.geode.pluginFetch with url/method/headers", async () => {
    const proxy = vi.fn(async () => jsonResponse({ ok: true }));
    (globalThis as any).window = { geode: { pluginFetch: proxy } };

    const res = await pluginFetch("https://example.test/items", {
      method: "POST",
      headers: { "X-Api-Key": "secret" },
      body: "hello",
    });

    expect(proxy).toHaveBeenCalledOnce();
    const [request] = proxy.mock.calls[0];
    expect(request.url).toBe("https://example.test/items");
    expect(request.method).toBe("POST");
    expect(request.headers["x-api-key"]).toBe("secret");
    expect(new TextDecoder().decode(request.bodyBuffer)).toBe("hello");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serializes a FormData body into multipart bytes with a boundary-bearing Content-Type", async () => {
    const proxy = vi.fn(async () => jsonResponse({ ok: true }));
    (globalThis as any).window = { geode: { pluginFetch: proxy } };

    const form = new FormData();
    form.set("file", new Blob(["audio-bytes"], { type: "application/octet-stream" }), "clip.webm");
    form.set("model", "whisper-1");

    await pluginFetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-test" },
      body: form,
    });

    expect(proxy).toHaveBeenCalledOnce();
    const [request] = proxy.mock.calls[0];
    expect(request.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=.+/);
    expect(request.headers["authorization"]).toBe("Bearer sk-test");
    expect(request.bodyBuffer).toBeInstanceOf(ArrayBuffer);
    expect(request.bodyBuffer.byteLength).toBeGreaterThan(0);
    // The encoded multipart body carries both field names and the file bytes.
    const decoded = new TextDecoder().decode(request.bodyBuffer);
    expect(decoded).toContain('name="model"');
    expect(decoded).toContain("whisper-1");
    expect(decoded).toContain('name="file"');
    expect(decoded).toContain("audio-bytes");
  });

  it("reconstructs a spec-compliant Response from the proxy's result", async () => {
    const proxy = vi.fn(async () => jsonResponse(
      { detail: "nope" },
      { status: 401, statusText: "Unauthorized" },
    ));
    (globalThis as any).window = { geode: { pluginFetch: proxy } };

    const res = await pluginFetch("https://example.test/secure");

    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.statusText).toBe("Unauthorized");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ detail: "nope" });
  });

  it("falls back to native fetch when no privileged bridge is present", async () => {
    delete (globalThis as any).window;
    const nativeFetch = vi.fn(async () => new Response("native", { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = nativeFetch as unknown as typeof fetch;
    try {
      const res = await pluginFetch("https://example.test/x");
      expect(nativeFetch).toHaveBeenCalledOnce();
      expect(await res.text()).toBe("native");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to native fetch for a non-http(s) URL even when a bridge is present", async () => {
    const proxy = vi.fn();
    (globalThis as any).window = { geode: { pluginFetch: proxy } };
    const nativeFetch = vi.fn(async () => new Response("local", { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = nativeFetch as unknown as typeof fetch;
    try {
      const res = await pluginFetch("data:text/plain,hi");
      expect(proxy).not.toHaveBeenCalled();
      expect(nativeFetch).toHaveBeenCalledOnce();
      expect(await res.text()).toBe("local");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("instantiatePluginClass fetch shadowing", () => {
  it("routes a compiled plugin bundle's bare fetch() call through the injected proxy, not native fetch", async () => {
    const proxy = vi.fn(async () => jsonResponse({ transcript: "hello world" }));
    (globalThis as any).window = { geode: { pluginFetch: proxy } };
    const nativeFetch = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = nativeFetch as unknown as typeof fetch;

    try {
      const Probe = instantiatePluginClass(
        `
          module.exports = class {
            static async call() {
              const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: { Authorization: 'Bearer sk-test' },
                body: 'raw-bytes',
              });
              return res.json();
            }
          };
        `,
        "fetch-shadow-probe",
      ) as unknown as { call: () => Promise<unknown> };

      const result = await Probe.call();
      expect(result).toEqual({ transcript: "hello world" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(nativeFetch).not.toHaveBeenCalled();
    expect(proxy).toHaveBeenCalledOnce();
    const [request] = proxy.mock.calls[0];
    expect(request.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe("Bearer sk-test");
  });
});
