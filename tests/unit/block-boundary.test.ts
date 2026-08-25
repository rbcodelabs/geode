import { describe, expect, it } from "vitest";
import { resolveBlockBoundary } from "../../src/renderer/block-boundary";
import type { ListItemCache, SectionCache } from "../../src/renderer/types";

/** Single-line-granularity Loc builder (ch/offset don't matter to the resolver). */
function loc(startLine: number, endLine: number) {
  return {
    start: { line: startLine, ch: 0, offset: 0 },
    end: { line: endLine, ch: 0, offset: 0 },
  };
}

function section(type: string, startLine: number, endLine: number): SectionCache {
  return { type, position: loc(startLine, endLine) };
}

function listItem(line: number): ListItemCache {
  return { position: loc(line, line), parent: -1 - line };
}

describe("resolveBlockBoundary", () => {
  it("targets the section's end line for a multi-line paragraph", () => {
    const sections = [section("paragraph", 2, 4)];
    expect(resolveBlockBoundary(2, sections, [])).toEqual({ kind: "line", line: 4 });
    expect(resolveBlockBoundary(4, sections, [])).toEqual({ kind: "line", line: 4 });
  });

  it("refuses inside a fenced code block (FIX 3)", () => {
    const sections = [section("code", 1, 5)];
    const result = resolveBlockBoundary(3, sections, []);
    expect(result.kind).toBe("refuse");
  });

  it("refuses inside YAML frontmatter (FIX 3)", () => {
    const sections = [section("yaml", 0, 3)];
    expect(resolveBlockBoundary(1, sections, []).kind).toBe("refuse");
  });

  it("targets the specific list item under the cursor, not the section end (FIX 4)", () => {
    // One "list" section spanning lines 0-2, with three single-line items.
    const sections = [section("list", 0, 2)];
    const items = [listItem(0), listItem(1), listItem(2)];
    expect(resolveBlockBoundary(0, sections, items)).toEqual({ kind: "line", line: 0 });
    expect(resolveBlockBoundary(1, sections, items)).toEqual({ kind: "line", line: 1 });
    expect(resolveBlockBoundary(2, sections, items)).toEqual({ kind: "line", line: 2 });
  });

  it("falls back to the cursor line when no section encloses it", () => {
    expect(resolveBlockBoundary(7, [], [])).toEqual({ kind: "line", line: 7 });
  });

  it("falls back to the cursor line for a list section with no matching item", () => {
    const sections = [section("list", 0, 2)];
    expect(resolveBlockBoundary(1, sections, [])).toEqual({ kind: "line", line: 1 });
  });
});
