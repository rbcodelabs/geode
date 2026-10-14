import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncStatusKey, watchSyncStatus } from "../../src/renderer/sync/status-refresh";
import type { SyncStatus } from "../../src/renderer/sync/types";

const status = (patch: Partial<SyncStatus> = {}): SyncStatus => ({ state: "disconnected", conflicts: 0, ...patch } as SyncStatus);
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function harness(over: { live?: () => boolean; editing?: () => boolean } = {}) {
  let listener: (s: SyncStatus) => void = () => {}; let subscribed = 0, unsubscribed = 0, redraws = 0;
  const stop = watchSyncStatus(status(), {
    subscribe: l => { listener = l; subscribed++; return () => { unsubscribed++; }; },
    isLive: over.live ?? (() => true), isEditing: over.editing ?? (() => false), redraw: () => { redraws++; },
  });
  return { emit: (s: SyncStatus) => listener(s), stop, get redraws() { return redraws; }, get subscribed() { return subscribed; }, get unsubscribed() { return unsubscribed; } };
}

describe("Sync tab status refresh", () => {
  it("redraws once, after the debounce, when the visible status changes (a burst is one redraw)", () => {
    const h = harness();
    h.emit(status({ state: "syncing" })); h.emit(status({ state: "idle", message: "done" })); h.emit(status({ state: "idle", message: "done" }));
    expect(h.redraws).toBe(0);
    vi.advanceTimersByTime(300);
    expect(h.redraws).toBe(1);
    expect(h.unsubscribed).toBe(1);   // the redraw builds a new panel with its own watcher; this one retires
  });
  it("ignores events that change nothing visible (progress ticks)", () => {
    const h = harness();
    h.emit({ ...status(), progress: { phase: "transferring", completed: 3, total: 9 } } as SyncStatus);
    vi.advanceTimersByTime(1000);
    expect(h.redraws).toBe(0);
    expect(syncStatusKey(status())).toBe(syncStatusKey({ ...status(), progress: { phase: "x" } } as unknown as SyncStatus));
  });
  it("waits while the user is typing in a field, then redraws", () => {
    let editing = true; const h = harness({ editing: () => editing });
    h.emit(status({ state: "error", message: "2 file(s) blocked" }));
    vi.advanceTimersByTime(3000);
    expect(h.redraws).toBe(0);
    editing = false; vi.advanceTimersByTime(1100);
    expect(h.redraws).toBe(1);
  });
  it("unsubscribes and never redraws once the panel is gone, or when stopped", () => {
    let live = true; const h = harness({ live: () => live });
    h.emit(status({ state: "idle" })); live = false; vi.advanceTimersByTime(300);
    expect(h.redraws).toBe(0); expect(h.unsubscribed).toBe(1);
    const g = harness(); g.emit(status({ state: "idle" })); g.stop(); vi.advanceTimersByTime(1000);
    expect(g.redraws).toBe(0); expect(g.unsubscribed).toBe(1);
  });
});
