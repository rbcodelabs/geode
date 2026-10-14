import { afterEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  CapacitorHttp: { get: (o: unknown) => get(o) },
}));

import { createMobileArtifactTransport } from "../../src/renderer/host/mobile-http-transport";

afterEach(() => get.mockReset());

describe("mobile transport (native)", () => {
  it("re-encodes a body the native layer already parsed as JSON", async () => {
    get.mockResolvedValue({ status: 200, data: { schemaVersion: 1, plugins: [] } });
    const bytes = await createMobileArtifactTransport()("https://x.test/v1.json", { maxBytes: 1000 });
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ schemaVersion: 1, plugins: [] });
  });
  it("decodes base64 string bodies", async () => {
    get.mockResolvedValue({ status: 200, data: btoa("hello") });
    const bytes = await createMobileArtifactTransport()("https://x.test/a", { maxBytes: 1000 });
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });
});
