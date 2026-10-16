import { afterEach, expect, it, vi } from "vitest";
import { createElectronHost } from "../../src/renderer/host/electron-host";

afterEach(() => vi.unstubAllGlobals());

it("rejects host HTTP immediately while offline, without an IPC round trip", async () => {
  vi.stubGlobal("navigator", { onLine: false });
  const httpRequest = vi.fn(async () => ({ status: 200, headers: {}, body: new ArrayBuffer(0) }));
  const host = createElectronHost({ httpRequest } as never);
  await expect(host.network!.request({ url: "https://example.invalid" })).rejects.toThrow("Network request failed");
  expect(httpRequest).not.toHaveBeenCalled();
});

it("still goes over IPC when online", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const httpRequest = vi.fn(async () => ({ status: 200, headers: {}, body: new ArrayBuffer(0) }));
  const host = createElectronHost({ httpRequest } as never);
  await host.network!.request({ url: "https://example.invalid" });
  expect(httpRequest).toHaveBeenCalledOnce();
});
