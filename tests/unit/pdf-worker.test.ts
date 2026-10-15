import { describe, expect, it, vi } from "vitest";
const api = await import("../../src/renderer/pdf/verified-worker").catch(() => ({})) as typeof import("../../src/renderer/pdf/verified-worker");
class FakeWorker {
  handlers = new Map<string, Set<(event: any) => void>>(); terminate = vi.fn();
  addEventListener(name: string, callback: (event: any) => void) { const set = this.handlers.get(name) ?? new Set(); set.add(callback); this.handlers.set(name, set); }
  removeEventListener(name: string, callback: (event: any) => void) { this.handlers.get(name)?.delete(callback); }
  emit(name: string, event: unknown) { for (const callback of this.handlers.get(name) ?? []) callback(event); }
}
const realm = { process: "undefined", require: "undefined", geode: "undefined", electron: "undefined", ipcRenderer: "undefined", Buffer: "undefined", window: "undefined", document: "undefined" };
describe("PDF worker isolation handshake", () => {
  it("times out an unresponsive worker and ignores unrelated messages", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker(), ready = api.verifyPdfWorker(worker as any, "6.4.299");
      const failure = expect(ready).rejects.toThrow(/timed out/);
      worker.emit("message", { data: { sourceName: "worker", action: "ready" } });
      await vi.advanceTimersByTimeAsync(8000);
      await failure; expect(worker.terminate).toHaveBeenCalledOnce();
      expect([...worker.handlers.values()].every(set => set.size === 0)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("rejects an already cancelled session without leaving a worker alive", async () => {
    const worker = new FakeWorker(), controller = new AbortController(); controller.abort();
    await expect(api.verifyPdfWorker(worker as any, "6.4.299", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("accepts the matching real-worker readiness proof and removes startup listeners", async () => {
    expect(api.verifyPdfWorker).toBeTypeOf("function");
    const worker = new FakeWorker(), ready = api.verifyPdfWorker(worker as any, "6.4.299");
    worker.emit("message", { data: { kind: "geode-pdf-worker-ready", version: "6.4.299", realm } });
    expect(await ready).toBe(worker); expect(worker.terminate).not.toHaveBeenCalled();
    expect([...worker.handlers.values()].every(set => set.size === 0)).toBe(true);
  });
  it.each(["process", "require", "geode", "ipcRenderer", "electron", "Buffer", "window", "document"])("refuses a worker exposing %s", async key => {
    const worker = new FakeWorker(), ready = api.verifyPdfWorker(worker as any, "6.4.299");
    worker.emit("message", { data: { kind: "geode-pdf-worker-ready", version: "6.4.299", realm: { ...realm, [key]: "object" } } });
    await expect(ready).rejects.toThrow(/isolation/); expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("refuses version mismatch, worker error and cancellation without a fake-worker path", async () => {
    for (const reason of ["version", "error", "cancel"]) {
      const worker = new FakeWorker(), controller = new AbortController(), ready = api.verifyPdfWorker(worker as any, "6.4.299", controller.signal);
      if (reason === "version") worker.emit("message", { data: { kind: "geode-pdf-worker-ready", version: "old", realm } });
      if (reason === "error") worker.emit("error", {});
      if (reason === "cancel") controller.abort();
      await expect(ready).rejects.toThrow(); expect(worker.terminate).toHaveBeenCalledOnce();
    }
  });
});
