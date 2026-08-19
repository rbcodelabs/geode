import { describe, expect, it, vi } from "vitest";
import { handleWatchdogPowerEvent, isRendererHeartbeatStale } from "../../src/main/renderer-watchdog";

describe("renderer watchdog power events", () => {
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
});
