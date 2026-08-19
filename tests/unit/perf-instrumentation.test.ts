import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMeasures,
  getRecentMeasures,
  markEnd,
  markStart,
  measureOperation,
  recordMeasure,
  withPerfMark,
} from "../../src/renderer/perf-instrumentation";

/**
 * Node's `PerformanceObserver` (used internally to populate the ring
 * buffer) delivers entries asynchronously -- empirically, before
 * `setImmediate` callbacks but after microtasks. Awaiting one `setImmediate`
 * tick reliably flushes any pending delivery before assertions run.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("perf-instrumentation", () => {
  beforeEach(() => {
    clearMeasures();
  });

  it("markStart/markEnd records a measure with op, a non-negative duration, and a timestamp", async () => {
    markStart("leaf-activate");
    markEnd("leaf-activate");
    await flush();

    const measures = getRecentMeasures();
    expect(measures).toHaveLength(1);
    expect(measures[0].op).toBe("leaf-activate");
    expect(measures[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof measures[0].ts).toBe("number");
  });

  it("markEnd without a matching markStart does not throw and records nothing", async () => {
    expect(() => markEnd("never-started")).not.toThrow();
    await flush();
    expect(getRecentMeasures()).toEqual([]);
  });

  it("caps the ring buffer at its capacity, evicting the oldest entries", async () => {
    const total = 310; // > the 300-entry cap
    for (let i = 0; i < total; i++) {
      markStart("op");
      markEnd("op");
    }
    await flush();

    const measures = getRecentMeasures();
    expect(measures.length).toBe(300);
    expect(measures.every((m) => m.op === "op")).toBe(true);
  });

  it("clearMeasures empties the ring buffer", async () => {
    markStart("op");
    markEnd("op");
    await flush();
    expect(getRecentMeasures().length).toBeGreaterThan(0);

    clearMeasures();
    expect(getRecentMeasures()).toEqual([]);
  });

  it("records a duration measured by the metadata utility process", () => {
    recordMeasure("metadata-cache-disk-write", 12.5);
    expect(getRecentMeasures()).toEqual([
      expect.objectContaining({ op: "metadata-cache-disk-write", durationMs: 12.5 }),
    ]);
  });

  it("measureOperation records concurrent-safe sync and async timings", async () => {
    expect(measureOperation("startup-sync", () => 42)).toBe(42);
    await expect(measureOperation("startup-async", async () => "ok")).resolves.toBe("ok");
    expect(getRecentMeasures().map((item) => item.op)).toEqual(["startup-sync", "startup-async"]);
  });

  it("withPerfMark records a measure for a sync happy path and returns the value unchanged", async () => {
    const result = withPerfMark("leaf-create", () => 42);
    expect(result).toBe(42);

    await flush();
    expect(getRecentMeasures().some((m) => m.op === "leaf-create")).toBe(true);
  });

  it("withPerfMark records a measure for an async happy path and returns the resolved value", async () => {
    const result = await withPerfMark("view-mount", () => Promise.resolve("ok"));
    expect(result).toBe("ok");

    await flush();
    expect(getRecentMeasures().some((m) => m.op === "view-mount")).toBe(true);
  });

  it("withPerfMark still records a measure when the sync fn throws, and rethrows the error", async () => {
    expect(() =>
      withPerfMark("leaf-detach", () => {
        throw new Error("boom");
      })
    ).toThrow("boom");

    await flush();
    expect(getRecentMeasures().some((m) => m.op === "leaf-detach")).toBe(true);
  });

  it("withPerfMark still records a measure when the returned promise rejects, and rethrows", async () => {
    await expect(
      withPerfMark("leaf-detach-async", () => Promise.reject(new Error("nope")))
    ).rejects.toThrow("nope");

    await flush();
    expect(getRecentMeasures().some((m) => m.op === "leaf-detach-async")).toBe(true);
  });
});
