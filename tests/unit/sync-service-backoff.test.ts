import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncService } from "../../src/renderer/sync/sync-service";

let online = true; const listeners = new Map<string, Set<() => void>>();
const fireOnline = () => { online = true; for (const l of listeners.get("online") ?? []) l(); };

function make(runImpl: () => Promise<unknown>) {
  const service = new SyncService({} as never, () => "/synthetic/vault");
  (service as any).selected = { id: "history" };
  (service as any).status = { state: "idle", providerId: "history", conflicts: 0 };
  const run = vi.fn(runImpl); (service as any).run = run;
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { service: service as any, run };
}

beforeEach(() => {
  vi.useFakeTimers(); online = true; listeners.clear();
  vi.stubGlobal("navigator", { get onLine() { return online; } });
  vi.stubGlobal("addEventListener", (type: string, fn: () => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); });
  vi.stubGlobal("removeEventListener", (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); });
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("SyncService retry/backoff", () => {
  it("a poll tick during backoff does not run or reset the backoff timer", async () => {
    const { service, run } = make(async () => { throw new Error("Timed out connecting"); });
    service.schedule(0); await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    // jitter 0 => equal jitter gives base/2 = 1s for the first retry; poll ticks every second must not trigger runs early
    for (let i = 0; i < 5; i++) { service.poll(); await vi.advanceTimersByTimeAsync(100); }
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000); expect(run).toHaveBeenCalledTimes(2);
  });

  it("grows the delay with each failure and caps it", async () => {
    const { service, run } = make(async () => { throw new Error("down"); });
    service.schedule(0); await vi.advanceTimersByTimeAsync(1);
    const times: number[] = [];
    for (let i = 0; i < 14; i++) { const before = run.mock.calls.length; const start = Date.now(); while (run.mock.calls.length === before) await vi.advanceTimersByTimeAsync(500); times.push(Math.round((Date.now() - start) / 500) * 500); }
    expect(times[1]).toBeGreaterThan(times[0]); expect(times[3]).toBeGreaterThan(times[1]);
    expect(Math.max(...times)).toBeLessThanOrEqual(300_000); expect(times.at(-1)).toBeGreaterThanOrEqual(times.at(-2)!);
    expect(times.at(-1)).toBeGreaterThanOrEqual(150_000); // capped region: random=0 => equal jitter floor is cap/2
  });

  it("does not run while offline, and resumes when the online event fires", async () => {
    online = false;
    const { service, run } = make(async () => ({}));
    service.schedule(0); await vi.advanceTimersByTimeAsync(60_000); service.poll(); await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
    fireOnline(); await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("success resets the backoff", async () => {
    let fail = true; const { service, run } = make(async () => { if (fail) throw new Error("down"); return {}; });
    service.schedule(0); await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1_000); await vi.advanceTimersByTimeAsync(2_000); // second and third failures
    expect(service.backoff.failures).toBeGreaterThanOrEqual(3);
    fail = false; await vi.advanceTimersByTimeAsync(10_000);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("never starts a second run while one is in flight", async () => {
    const { service, run } = make(async () => ({}));
    service.running = new Promise(() => {});
    service.schedule(0); await vi.advanceTimersByTimeAsync(10); service.poll(); await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("removes the online listener on cancel", async () => {
    online = false; const { service } = make(async () => ({}));
    service.schedule(0); await vi.advanceTimersByTimeAsync(10);
    expect(listeners.get("online")?.size).toBe(1);
    await service.cancel();
    expect(listeners.get("online")?.size ?? 0).toBe(0);
  });
});
