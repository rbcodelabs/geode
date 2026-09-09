import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWatchdogPowerEvent, isRendererHeartbeatStale } from "../../src/main/renderer-watchdog";

describe("renderer watchdog power events", () => {
  beforeEach(() => handleWatchdogPowerEvent(new Map(), "resume", 0, vi.fn()));
  it("gives every live renderer a fresh grace period after resume", () => {
    const staleHeartbeat = 1_000;
    const resumedAt = 60_000;
    const states = new Map([
      [1, { lastHeartbeat: staleHeartbeat }],
      [2, { lastHeartbeat: staleHeartbeat }],
    ]);
    const record = vi.fn();

    handleWatchdogPowerEvent(states, "resume", resumedAt, record);

    expect([...states.values()].map((state) => state.lastHeartbeat)).toEqual([resumedAt, resumedAt]);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenNthCalledWith(1, states.get(1), {
      at: resumedAt,
      category: "power",
      message: "power-resume",
    });
    expect(isRendererHeartbeatStale(states.get(1)!.lastHeartbeat, resumedAt + 19_999, 20_000)).toBe(false);
    expect(isRendererHeartbeatStale(states.get(1)!.lastHeartbeat, resumedAt + 20_000, 20_000)).toBe(true);
  });

  it("records suspend without changing the heartbeat baseline", () => {
    const state = { lastHeartbeat: 1_000 };
    const states = new Map([[1, state]]);
    const record = vi.fn();

    handleWatchdogPowerEvent(states, "suspend", 10_000, record);

    expect(state.lastHeartbeat).toBe(1_000);
    expect(record).toHaveBeenCalledWith(state, {
      at: 10_000,
      category: "power",
      message: "power-suspend",
    });
  });

  it("ignores an overdue watchdog callback before resume across repeated sleep cycles", () => {
    const state = { lastHeartbeat: 1_000 };
    const states = new Map([[1, state]]);
    for (const suspendedAt of [2_000, 100_000]) {
      handleWatchdogPowerEvent(states, "suspend", suspendedAt, vi.fn());
      expect(isRendererHeartbeatStale(state.lastHeartbeat, suspendedAt + 60_000, 20_000)).toBe(false);
      handleWatchdogPowerEvent(states, "resume", suspendedAt + 60_001, vi.fn());
      expect(isRendererHeartbeatStale(state.lastHeartbeat, suspendedAt + 80_000, 20_000)).toBe(false);
      expect(isRendererHeartbeatStale(state.lastHeartbeat, suspendedAt + 80_001, 20_000)).toBe(true);
    }
  });

  it("gates every live window and leaves a closed window out of resume handling", () => {
    const first = { lastHeartbeat: 1_000 };
    const second = { lastHeartbeat: 2_000 };
    const states = new Map([[1, first], [2, second]]);
    const record = vi.fn();
    handleWatchdogPowerEvent(states, "suspend", 3_000, record);
    expect(isRendererHeartbeatStale(first.lastHeartbeat, 60_000, 20_000)).toBe(false);
    expect(isRendererHeartbeatStale(second.lastHeartbeat, 60_000, 20_000)).toBe(false);
    states.delete(1);
    record.mockClear();
    handleWatchdogPowerEvent(states, "resume", 60_000, record);
    expect(first.lastHeartbeat).toBe(1_000);
    expect(second.lastHeartbeat).toBe(60_000);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("protects windows created while suspended with no windows at suspend", () => {
    const states = new Map<number, { lastHeartbeat: number }>();
    handleWatchdogPowerEvent(states, "suspend", 2_000, vi.fn());
    states.set(1, { lastHeartbeat: 3_000 });
    expect(isRendererHeartbeatStale(states.get(1)!.lastHeartbeat, 60_000, 20_000)).toBe(false);
    handleWatchdogPowerEvent(states, "resume", 60_001, vi.fn());
    expect(isRendererHeartbeatStale(states.get(1)!.lastHeartbeat, 80_001, 20_000)).toBe(true);
  });
});
