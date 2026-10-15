import { describe, expect, it, vi } from "vitest";
const api = await import("../../src/renderer/pdf/handshake").catch(() => ({})) as typeof import("../../src/renderer/pdf/handshake");
const nonce = "a".repeat(64), parent = {};
const init = { kind: "geode-pdf-init", version: 1, build: "6.4.299", generation: 2, nonce };
const realm = { process: "undefined", require: "undefined", geode: "undefined", electron: "undefined", ipcRenderer: "undefined", Buffer: "undefined" };
const ready = { kind: "geode-pdf-ready", version: 1, build: "6.4.299", generation: 2, nonce, realm };
describe("owned PDF private-port initialization", () => {
  it("accepts exactly one parent initialization at the characterized opaque file origin", () => {
    expect(api.createPdfFrameInitializer).toBeTypeOf("function");
    const accepted: unknown[] = [], receive = api.createPdfFrameInitializer(parent as Window, value => accepted.push(value));
    const channel = new MessageChannel(), second = new MessageChannel();
    try {
      const event = { source: parent, origin: "null", data: init, ports: [channel.port2] } as any;
      receive({ ...event, source: {} }); receive({ ...event, origin: "https://example.test" }); receive({ ...event, data: { ...init, version: 2 } }); receive({ ...event, data: { ...init, nonce: "short" } }); receive({ ...event, data: { ...init, url: "file:///private" } }); receive({ ...event, ports: [] });
      expect(accepted).toHaveLength(0); receive(event); receive({ ...event, ports: [second.port2] }); expect(accepted).toHaveLength(1);
    } finally { channel.port1.close(); channel.port2.close(); second.port1.close(); second.port2.close(); }
  });
  it("accepts readiness only on the captured port with matching nonce/build/generation and isolated frame realm", async () => {
    expect(api.waitForPdfFrameReady).toBeTypeOf("function"); const channel = new MessageChannel();
    try { const pending = api.waitForPdfFrameReady(channel.port1, init as any, () => true); channel.port2.postMessage(ready); await expect(pending).resolves.toBeUndefined(); }
    finally { channel.port1.close(); channel.port2.close(); }
  });
  it("ignores a forged foreign port and closes the captured port on timeout", async () => {
    expect(api.waitForPdfFrameReady).toBeTypeOf("function"); vi.useFakeTimers();
    const channel = new MessageChannel(), foreign = new MessageChannel();
    try {
      const pending = api.waitForPdfFrameReady(channel.port1, init as any, () => true), failure = expect(pending).rejects.toThrow(/timed out/);
      foreign.port2.postMessage(ready); await vi.advanceTimersByTimeAsync(8000); await failure;
    } finally { channel.port1.close(); channel.port2.close(); foreign.port1.close(); foreign.port2.close(); vi.useRealTimers(); }
  });
  it("rejects forged readiness, stale generations and cancellation", async () => {
    expect(api.waitForPdfFrameReady).toBeTypeOf("function");
    for (const packet of [{ ...ready, path: "private" }, { ...ready, nonce: "b".repeat(64) }, { ...ready, build: "old" }, { ...ready, generation: 1 }, { ...ready, realm: { ...realm, geode: "object" } }]) {
      const channel = new MessageChannel(); try { const pending = api.waitForPdfFrameReady(channel.port1, init as any, () => true); channel.port2.postMessage(packet); await expect(pending).rejects.toThrow(/PDF/); } finally { channel.port1.close(); channel.port2.close(); }
    }
    const channel = new MessageChannel(), controller = new AbortController();
    try {
      const pending = api.waitForPdfFrameReady(channel.port1, init as any, () => false); await expect(pending).rejects.toThrow(/changed|cancel/i);
      const cancelled = api.waitForPdfFrameReady(channel.port2, init as any, () => true, controller.signal); controller.abort(); await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    } finally { channel.port1.close(); channel.port2.close(); }
  });
});
