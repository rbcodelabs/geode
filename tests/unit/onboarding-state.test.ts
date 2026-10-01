import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyChecks,
  dismissStep,
  emptyState,
  markComplete,
  normalizeState,
  restoreStep,
  runCheck,
  unmarkComplete,
} from "../../src/renderer/internal-plugins/onboarding/state";

const NOW = new Date("2026-09-30T12:00:00Z");

afterEach(() => vi.restoreAllMocks());

describe("normalizeState", () => {
  it("returns defaults for garbage", () => {
    for (const bad of [null, undefined, 42, "x", [], { completed: 5, dismissedSteps: "no" }]) {
      expect(normalizeState(bad)).toEqual(emptyState());
    }
  });

  it("round-trips a valid state and drops malformed entries", () => {
    const raw = {
      version: 1,
      completed: {
        "a:1": { completedAt: "2026-01-01T00:00:00.000Z", source: "auto" },
        "a:2": { completedAt: 5 },
        "a:3": null,
        "a:4": { completedAt: "2026-01-02T00:00:00.000Z", source: "weird" },
      },
      dismissedSteps: ["a:9", "a:9", 7],
      dismissedOnboarding: true,
    };
    const s = normalizeState(raw);
    expect(Object.keys(s.completed)).toEqual(["a:1", "a:4"]);
    expect(s.completed["a:4"].source).toBe("manual");
    expect(s.dismissedSteps).toEqual(["a:9"]);
    expect(s.dismissedOnboarding).toBe(true);
  });
});

describe("state transitions", () => {
  it("mark/unmark complete is immutable and idempotent", () => {
    const s0 = emptyState();
    const s1 = markComplete(s0, "a:1", "manual", NOW);
    expect(s0.completed).toEqual({});
    expect(s1.completed["a:1"]).toEqual({ completedAt: NOW.toISOString(), source: "manual" });
    expect(markComplete(s1, "a:1", "auto", NOW)).toBe(s1);
    expect(unmarkComplete(s1, "a:1").completed).toEqual({});
    expect(unmarkComplete(s0, "a:1")).toBe(s0);
  });

  it("dismiss and restore steps", () => {
    const s1 = dismissStep(emptyState(), "a:1");
    expect(s1.dismissedSteps).toEqual(["a:1"]);
    expect(dismissStep(s1, "a:1")).toBe(s1);
    expect(restoreStep(s1, "a:1").dismissedSteps).toEqual([]);
  });
});

describe("runCheck / applyChecks", () => {
  it("true completes; false, non-boolean, throw, rejection and timeout are incomplete and never throw", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runCheck({ id: "x", check: () => true })).toBe(true);
    expect(await runCheck({ id: "x", check: async () => true })).toBe(true);
    expect(await runCheck({ id: "x", check: () => false })).toBe(false);
    expect(await runCheck({ id: "x", check: (() => "yes") as never })).toBe(false);
    expect(await runCheck({ id: "x", check: () => { throw new Error("sync"); } })).toBe(false);
    expect(await runCheck({ id: "x", check: () => Promise.reject(new Error("async")) })).toBe(false);
    expect(await runCheck({ id: "x", check: () => new Promise<boolean>(() => {}) }, 10)).toBe(false);
    expect(await runCheck({ id: "x" })).toBe(false);
  });

  it("auto-completes passing steps, ignores erroring ones, and keeps unchanged state identity", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const steps = [
      { id: "a:ok", check: () => true },
      { id: "a:bad", check: () => { throw new Error("nope"); } },
      { id: "a:no", check: () => false },
      { id: "a:manual" },
    ];
    const next = await applyChecks(emptyState(), steps, NOW);
    expect(Object.keys(next.completed)).toEqual(["a:ok"]);
    expect(next.completed["a:ok"].source).toBe("auto");
    expect(await applyChecks(next, steps, NOW)).toBe(next);
  });

  it("completion is sticky and never overwrites a manual completion", async () => {
    let ok = true;
    const steps = [{ id: "a:t", check: () => ok }, { id: "a:m", check: () => true }];
    let state = markComplete(emptyState(), "a:m", "manual", NOW);
    state = await applyChecks(state, steps, NOW);
    ok = false;
    state = await applyChecks(state, steps, NOW);
    expect(state.completed["a:t"].source).toBe("auto");
    expect(state.completed["a:m"].source).toBe("manual");
  });
});
