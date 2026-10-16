import { describe, expect, it } from "vitest";
import { Backoff, nextDelay } from "../../src/shared/backoff";

describe("nextDelay", () => {
  const opts = { baseMs: 1000, maxMs: 30_000 };
  it("grows exponentially without jitter", () => {
    expect([0, 1, 2, 3].map(a => nextDelay(a, { ...opts, jitter: "none" }))).toEqual([1000, 2000, 4000, 8000]);
  });
  it("caps at maxMs, including for huge attempt counts", () => {
    expect(nextDelay(10, { ...opts, jitter: "none" })).toBe(30_000);
    expect(nextDelay(5000, { ...opts, jitter: "none" })).toBe(30_000);
  });
  it("full jitter spans [0, raw]", () => {
    expect(nextDelay(2, { ...opts, jitter: "full", random: () => 0 })).toBe(0);
    expect(nextDelay(2, { ...opts, jitter: "full", random: () => 0.5 })).toBe(2000);
    expect(nextDelay(2, { ...opts, jitter: "full", random: () => 0.999999 })).toBeLessThan(4000);
  });
  it("equal jitter spans [raw/2, raw]", () => {
    expect(nextDelay(2, { ...opts, jitter: "equal", random: () => 0 })).toBe(2000);
    expect(nextDelay(2, { ...opts, jitter: "equal", random: () => 0.5 })).toBe(3000);
    expect(nextDelay(10, { ...opts, jitter: "equal", random: () => 0.999999 })).toBeLessThanOrEqual(30_000);
  });
  it("treats negative attempts as zero", () => { expect(nextDelay(-3, { ...opts, jitter: "none" })).toBe(1000); });
});

describe("Backoff", () => {
  it("tracks consecutive failures and resets on success", () => {
    const backoff = new Backoff({ baseMs: 100, maxMs: 1000, jitter: "none" });
    expect(backoff.failures).toBe(0);
    expect([backoff.failure(), backoff.failure(), backoff.failure(), backoff.failure(), backoff.failure()]).toEqual([100, 200, 400, 800, 1000]);
    expect(backoff.failures).toBe(5);
    backoff.reset();
    expect(backoff.failures).toBe(0);
    expect(backoff.failure()).toBe(100);
  });
});
