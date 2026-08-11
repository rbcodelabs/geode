import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "../../src/renderer/modals/modals";

describe("fuzzyMatch", () => {
  it("returns 0 for an empty query against any text", () => {
    expect(fuzzyMatch("", "Anything")).toBe(0);
  });

  it("returns null when the query characters aren't all present in order", () => {
    expect(fuzzyMatch("xyz", "Daily Plan")).toBeNull();
    expect(fuzzyMatch("la", "al")).toBeNull(); // present, but in the wrong order
  });

  it("matches a non-contiguous subsequence", () => {
    expect(fuzzyMatch("dpl", "Daily Plan")).not.toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("DAILY", "daily plan")).not.toBeNull();
    expect(fuzzyMatch("daily", "Daily Plan")).not.toBeNull();
  });

  it("scores an exact substring match higher than a scattered subsequence match", () => {
    const exact = fuzzyMatch("plan", "Daily Plan");
    const scattered = fuzzyMatch("pln", "Daily Plan");
    expect(exact).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(exact!).toBeGreaterThan(scattered!);
  });

  it("scores letters at word boundaries higher than the same scattered letters mid-word", () => {
    // Neither "dp" nor "rc" appears as a contiguous substring, so both fall
    // into the scattered-subsequence scoring path where the word-start
    // bonus (each letter starts a word) applies.
    const wordStart = fuzzyMatch("dp", "Daily Plan");
    const midWord = fuzzyMatch("dp", "adopted");
    expect(wordStart).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(wordStart!).toBeGreaterThan(midWord!);
  });

  it("prefers a shorter overall match for the same query", () => {
    const short = fuzzyMatch("note", "note");
    const long = fuzzyMatch("note", "note with a much longer title");
    expect(short!).toBeGreaterThan(long!);
  });

  it("rewards contiguous runs over gapped matches of the same query", () => {
    const contiguous = fuzzyMatch("plan", "Plan Roadmap");
    const gapped = fuzzyMatch("plan", "P roadmap l a n");
    expect(contiguous!).toBeGreaterThan(gapped!);
  });
});
