import { describe, expect, it } from "vitest";
import { describeGuestCrashCause } from "../../src/renderer/views/web-view-crash-message";
import type { FdPressureSnapshot } from "../../src/main/crash-diagnostics";

const healthy: FdPressureSnapshot = {
  openFileDescriptors: 62,
  limit: 10_240,
  ratio: 0.006,
  underPressure: false,
  exhausted: false,
};

const saturated: FdPressureSnapshot = {
  openFileDescriptors: 9_999,
  limit: 10_240,
  ratio: 0.976,
  underPressure: true,
  exhausted: false,
};

describe("describeGuestCrashCause", () => {
  it("leaves the generic crash message alone when descriptors are plentiful", () => {
    expect(describeGuestCrashCause("crashed (exit code 6)", healthy)).toBeNull();
  });

  it("leaves the generic message alone when the probe is unavailable", () => {
    expect(describeGuestCrashCause("crashed (exit code 6)", null)).toBeNull();
  });

  it("names descriptor exhaustion, with the real numbers, when the table is full", () => {
    const message = describeGuestCrashCause("crashed (exit code 6)", saturated);
    expect(message?.title).toBe("This page crashed — out of file handles");
    expect(message?.detail).toContain("9999 of 10240 available file handles are in use");
    // The original reason survives — it is what distinguishes one crash from
    // another in a bug report.
    expect(message?.detail).toContain("crashed (exit code 6)");
  });

  it("still explains itself when the limit could not be read", () => {
    const message = describeGuestCrashCause("killed", {
      openFileDescriptors: null,
      limit: null,
      ratio: null,
      underPressure: true,
      exhausted: true,
    });
    expect(message?.title).toBe("This page crashed — out of file handles");
    expect(message?.detail).toContain("this process has run out of file handles");
    expect(message?.detail).not.toContain("null");
  });
});
