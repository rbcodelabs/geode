import { describe, expect, it } from "vitest";
import { DEFAULT_UPDATE_CHECK_INTERVAL_MS, shouldCheckForUpdates } from "../../src/main/update-scheduler";

describe("shouldCheckForUpdates", () => {
  it("always checks when never checked before", () => {
    expect(shouldCheckForUpdates(null, 1_000_000)).toBe(true);
  });

  it("checks exactly at the interval boundary (inclusive)", () => {
    const now = 10_000_000;
    const lastCheckedAt = now - DEFAULT_UPDATE_CHECK_INTERVAL_MS;
    expect(shouldCheckForUpdates(lastCheckedAt, now)).toBe(true);
  });

  it("does not check when short of the interval", () => {
    const now = 10_000_000;
    const lastCheckedAt = now - DEFAULT_UPDATE_CHECK_INTERVAL_MS + 1;
    expect(shouldCheckForUpdates(lastCheckedAt, now)).toBe(false);
  });

  it("does not check when the clock has skewed backwards (now < lastCheckedAt)", () => {
    const lastCheckedAt = 10_000_000;
    const now = lastCheckedAt - 1;
    expect(shouldCheckForUpdates(lastCheckedAt, now)).toBe(false);
  });

  it("honors a custom interval", () => {
    const intervalMs = 60_000;
    expect(shouldCheckForUpdates(1_000_000, 1_000_000 + intervalMs, intervalMs)).toBe(true);
    expect(shouldCheckForUpdates(1_000_000, 1_000_000 + intervalMs - 1, intervalMs)).toBe(false);
  });
});
