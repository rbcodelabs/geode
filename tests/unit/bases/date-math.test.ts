import { describe, expect, it } from "vitest";
import { addDuration, formatDate, parseDateString, parseDuration, relativeDate, today } from "../../../src/renderer/bases/date-math";

describe("parseDuration", () => {
  it("parses the compact form (number + single unit letter)", () => {
    expect(parseDuration("1M")).toEqual({ amount: 1, unit: "M" });
    expect(parseDuration("2h")).toEqual({ amount: 2, unit: "h" });
  });

  it("is case-sensitive for the compact unit letter (m = minute, M = month)", () => {
    expect(parseDuration("5m")).toEqual({ amount: 5, unit: "m" });
    expect(parseDuration("5M")).toEqual({ amount: 5, unit: "M" });
  });

  it("parses every documented unit letter", () => {
    for (const unit of ["y", "M", "w", "d", "h", "m", "s"] as const) {
      expect(parseDuration(`3${unit}`)).toEqual({ amount: 3, unit });
    }
  });

  it("parses the spaced word form, case-insensitively, singular or plural", () => {
    expect(parseDuration("1 day")).toEqual({ amount: 1, unit: "d" });
    expect(parseDuration("2 hours")).toEqual({ amount: 2, unit: "h" });
    expect(parseDuration("3 Weeks")).toEqual({ amount: 3, unit: "w" });
  });

  it("returns null for unparseable input instead of throwing", () => {
    expect(() => parseDuration("nonsense")).not.toThrow();
    expect(parseDuration("nonsense")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("addDuration", () => {
  it("adds a duration to an epoch-ms date", () => {
    const base = Date.UTC(2025, 0, 1); // 2025-01-01
    const result = addDuration(base, 1, "M");
    expect(new Date(result).getUTCMonth()).toBe(1); // February
  });

  it("supports negative amounts (subtraction)", () => {
    const base = Date.UTC(2025, 0, 10);
    const result = addDuration(base, -1, "w");
    expect(new Date(result).getUTCDate()).toBe(3);
  });
});

describe("parseDateString", () => {
  it("parses the documented 'YYYY-MM-DD HH:mm:ss' format", () => {
    expect(parseDateString("2025-01-01 12:00:00")).not.toBeNull();
  });

  it("parses a date-only string", () => {
    expect(parseDateString("2025-06-01")).not.toBeNull();
  });

  it("parses ISO 8601", () => {
    expect(parseDateString("2025-06-01T10:00:00Z")).not.toBeNull();
  });

  it("returns null for a non-date string (strict, never throws)", () => {
    expect(() => parseDateString("not a date")).not.toThrow();
    expect(parseDateString("not a date")).toBeNull();
  });

  it("rejects a format outside the accepted list even if moment could loosely parse it", () => {
    // Strict multi-format parsing: "01/06/2025" isn't one of the accepted formats.
    expect(parseDateString("01/06/2025")).toBeNull();
  });
});

describe("today", () => {
  it("strips time back to midnight", () => {
    const now = Date.UTC(2025, 5, 1, 15, 30, 0);
    const t = today(now);
    const d = new Date(t);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});

describe("formatDate / relativeDate", () => {
  it("formats a date with a moment pattern", () => {
    // moment().format() renders in local time, so use a local-time
    // constructor here rather than Date.UTC (which could shift to the
    // previous/next day depending on the test runner's timezone).
    const ms = new Date(2025, 0, 1).getTime();
    expect(formatDate(ms, "YYYY")).toBe("2025");
  });

  it("produces a non-empty relative description", () => {
    const now = Date.now();
    expect(relativeDate(now - 1000 * 60 * 60 * 24 * 3, now)).toMatch(/ago/);
  });
});
