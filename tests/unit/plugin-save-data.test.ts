import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Plugin } from "../../src/renderer/plugin";

class TestPlugin extends Plugin {}
const make = (id = "demo") => new TestPlugin({ host: {} } as never, { id, name: id, version: "1", minAppVersion: "0" } as never);
let write: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  write = vi.fn(async () => {});
  vi.stubGlobal("window", { geode: { write }, addEventListener: vi.fn() });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Plugin.saveData coalescing", () => {
  it("collapses 50 rapid saves into one write of the latest value", async () => {
    const plugin = make("burst");
    const saves = Array.from({ length: 50 }, (_, i) => plugin.saveData({ n: i }));
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000); await Promise.all(saves);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0][1])).toEqual({ n: 49 });
  });

  it("serializes lazily: one stringify per flush, not per call", async () => {
    const plugin = make("lazy"); let reads = 0;
    const data = { get x() { reads++; return 1; } };
    const saves = Array.from({ length: 20 }, () => plugin.saveData(data));
    expect(reads).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000); await Promise.all(saves);
    expect(reads).toBeLessThanOrEqual(2); // compact probe + pretty re-serialization of a small payload
  });

  it("skips a write whose serialized payload equals the last written one", async () => {
    const plugin = make("same");
    const first = plugin.saveData({ a: 1 }); await vi.advanceTimersByTimeAsync(5_000); await first;
    const second = plugin.saveData({ a: 1 }); await vi.advanceTimersByTimeAsync(5_000); await second;
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps at most one write in flight per plugin and writes the newest snapshot afterwards", async () => {
    const plugin = make("inflight"); let release!: () => void;
    write.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = plugin.saveData({ v: 1 }); await vi.advanceTimersByTimeAsync(2_000);
    expect(write).toHaveBeenCalledTimes(1);
    const second = plugin.saveData({ v: 2 }); await vi.advanceTimersByTimeAsync(5_000);
    expect(write).toHaveBeenCalledTimes(1);
    release(); await first; await vi.advanceTimersByTimeAsync(5_000); await second;
    expect(write).toHaveBeenCalledTimes(2); expect(JSON.parse(write.mock.calls[1][1])).toEqual({ v: 2 });
  });

  it("flushes immediately on unload", async () => {
    const plugin = make("unload"); const saved = plugin.saveData({ bye: true });
    expect(write).not.toHaveBeenCalled();
    await plugin.unloadAndWait(); await saved;
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("rejects the saveData promise when the write fails", async () => {
    const plugin = make("fails"); write.mockRejectedValueOnce(new Error("disk full"));
    const saved = plugin.saveData({ a: 1 }); const check = expect(saved).rejects.toThrow("disk full");
    await vi.advanceTimersByTimeAsync(5_000); await check;
    const retry = plugin.saveData({ a: 1 }); await vi.advanceTimersByTimeAsync(5_000); await retry;
    expect(write).toHaveBeenCalledTimes(2); // a failed write is not remembered as written
  });

  it("pretty-prints small payloads and compacts large ones", async () => {
    const small = make("small"); const s = small.saveData({ a: 1 }); await vi.advanceTimersByTimeAsync(5_000); await s;
    expect(write.mock.calls[0][1]).toBe(JSON.stringify({ a: 1 }, null, 2));
    const big = make("big"); const payload = { blob: "x".repeat(300 * 1024) };
    const b = big.saveData(payload); await vi.advanceTimersByTimeAsync(5_000); await b;
    expect(write.mock.calls[1][1]).toBe(JSON.stringify(payload));
  });

  it("loadData sees a pending save (flushes before reading)", async () => {
    const plugin = make("rw"); const disk = new Map<string, string>();
    write.mockImplementation(async (p: string, c: string) => { disk.set(p, c); });
    (window as any).geode.read = async (p: string) => disk.get(p) ?? Promise.reject(new Error("ENOENT"));
    void plugin.saveData({ fresh: true });
    expect(await plugin.loadData()).toEqual({ fresh: true });
  });
});
