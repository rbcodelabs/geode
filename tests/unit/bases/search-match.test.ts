import { describe, expect, it } from "vitest";
import { matchesSearch } from "../../../src/renderer/bases/search-match";

describe("matchesSearch", () => {
  it("matches case-insensitively against any displayed cell", () => {
    expect(matchesSearch(["Alpha Task", "Done", "3"], "done")).toBe(true);
    expect(matchesSearch(["Alpha Task", "Done", "3"], "ALPHA")).toBe(true);
  });

  it("returns false when no cell contains the query", () => {
    expect(matchesSearch(["Alpha Task", "Done", "3"], "gamma")).toBe(false);
  });

  it("treats an empty or whitespace-only query as matching everything", () => {
    expect(matchesSearch([], "")).toBe(true);
    expect(matchesSearch(["anything"], "   ")).toBe(true);
  });
});
