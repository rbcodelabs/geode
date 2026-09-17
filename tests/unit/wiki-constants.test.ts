import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMENT_DELIMITER,
  commentSpanPattern,
  DEFAULT_METADATA_SCAN_CAP_BYTES,
  FRONTMATTER_FENCE,
  FRONTMATTER_BLOCK_RE,
  FRONTMATTER_BLOCK_OPTIONAL_BODY_RE,
  FRONTMATTER_OPEN_RE,
  MATH_BLOCK_DELIMITER,
  MAX_METADATA_SCAN_CAP_BYTES,
  MIN_METADATA_SCAN_CAP_BYTES,
  resolveMetadataScanCapBytes,
} from "../../src/wiki/constants";
import * as indexer from "../../src/indexer/metadata-indexer";

const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("portable markdown syntax constants", () => {
  it("owns the comment, math and frontmatter delimiters", () => {
    expect(COMMENT_DELIMITER).toBe("%%");
    expect(MATH_BLOCK_DELIMITER).toBe("$$");
    expect(FRONTMATTER_FENCE).toBe("---");
  });

  it("matches a complete frontmatter block and captures its body", () => {
    const match = "---\ntitle: Note\n---\nbody".match(FRONTMATTER_BLOCK_RE);
    expect(match?.[1]).toBe("title: Note");
    expect(match?.[0]).toBe("---\ntitle: Note\n---\n");
  });

  it("matches a frontmatter block terminated by end-of-file, and CRLF line endings", () => {
    expect("---\na: 1\n---".match(FRONTMATTER_BLOCK_RE)?.[1]).toBe("a: 1");
    expect("---\r\na: 1\r\n---\r\nbody".match(FRONTMATTER_BLOCK_RE)?.[1]).toBe("a: 1");
  });

  it("does not match an unterminated or non-leading fence", () => {
    expect("---\ntitle: Note\nbody").not.toMatch(FRONTMATTER_BLOCK_RE);
    expect("text\n---\ntitle: Note\n---\n").not.toMatch(FRONTMATTER_BLOCK_RE);
  });

  it("recognises an opening fence independently of the closing one", () => {
    expect(FRONTMATTER_OPEN_RE.test("---\nanything")).toBe(true);
    expect(FRONTMATTER_OPEN_RE.test("----\nanything")).toBe(false);
    expect(FRONTMATTER_OPEN_RE.test("body\n---\n")).toBe(false);
  });

  it("exposes shareable (non-global) patterns that cannot carry lastIndex state between calls", () => {
    for (const pattern of [FRONTMATTER_BLOCK_RE, FRONTMATTER_OPEN_RE, FRONTMATTER_BLOCK_OPTIONAL_BODY_RE]) {
      expect(pattern.global).toBe(false);
      expect(pattern.sticky).toBe(false);
    }
  });

  it("matches an empty frontmatter block only under the rewrite-side pattern", () => {
    expect("---\n---\nbody").not.toMatch(FRONTMATTER_BLOCK_RE);
    const match = "---\n---\nbody".match(FRONTMATTER_BLOCK_OPTIONAL_BODY_RE);
    expect(match?.[0]).toBe("---\n---\n");
    expect(match?.[1]).toBeUndefined();
  });

  it("hands out a fresh global comment-span pattern per call, so lastIndex never leaks", () => {
    const first = commentSpanPattern();
    expect(first.global).toBe(true);
    first.exec("%%a%% %%b%%");
    expect(first.lastIndex).toBeGreaterThan(0);
    expect(commentSpanPattern().lastIndex).toBe(0);
  });

  it("strips whole comment spans, non-greedily", () => {
    expect("keep %%drop%% keep".replace(commentSpanPattern(), "")).toBe("keep  keep");
    expect("%%a%% mid %%b%%".replace(commentSpanPattern(), "")).toBe(" mid ");
    expect("%%multi\nline%%!".replace(commentSpanPattern(), "")).toBe("!");
  });
});

describe("portable metadata scan-cap constants", () => {
  it("keeps the shipped default, floor and ceiling", () => {
    expect(DEFAULT_METADATA_SCAN_CAP_BYTES).toBe(300_000);
    expect(MIN_METADATA_SCAN_CAP_BYTES).toBe(1_000);
    expect(MAX_METADATA_SCAN_CAP_BYTES).toBe(1_000_000_000);
  });

  it("falls back to the default for missing or non-numeric input", () => {
    for (const raw of [undefined, null, "300000", NaN, Infinity, {}]) {
      expect(resolveMetadataScanCapBytes(raw)).toBe(DEFAULT_METADATA_SCAN_CAP_BYTES);
    }
  });

  it("truncates and clamps numeric input into range", () => {
    expect(resolveMetadataScanCapBytes(500_000.9)).toBe(500_000);
    expect(resolveMetadataScanCapBytes(0)).toBe(MIN_METADATA_SCAN_CAP_BYTES);
    expect(resolveMetadataScanCapBytes(-1_000_000)).toBe(MIN_METADATA_SCAN_CAP_BYTES);
    expect(resolveMetadataScanCapBytes(Number.MAX_SAFE_INTEGER)).toBe(MAX_METADATA_SCAN_CAP_BYTES);
  });
});

describe("desktop compatibility of the moved constants", () => {
  it("keeps the indexer's existing exports working, as the same values", () => {
    expect(indexer.DEFAULT_METADATA_SCAN_CAP_BYTES).toBe(DEFAULT_METADATA_SCAN_CAP_BYTES);
    expect(indexer.MIN_METADATA_SCAN_CAP_BYTES).toBe(MIN_METADATA_SCAN_CAP_BYTES);
    expect(indexer.MAX_METADATA_SCAN_CAP_BYTES).toBe(MAX_METADATA_SCAN_CAP_BYTES);
    expect(indexer.resolveMetadataScanCapBytes).toBe(resolveMetadataScanCapBytes);
  });
});

describe("portable ownership boundary", () => {
  // The point of the move: the portable parser must no longer reach back into
  // the desktop indexer for its constants. The Node proofs enforce the same
  // rule on the bundled input graph; this is the cheap source-level guard that
  // fails in the ordinary unit run instead of only under esbuild.
  it("has no src/wiki module importing the desktop indexer", () => {
    // Match import/export *statements* only. Matching the bare path would also
    // fire on prose in a doc comment explaining why the dependency was removed.
    const importsIndexer = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["'][^"']*indexer\/metadata-indexer["']/;
    for (const path of [
      "src/wiki/metadata.ts",
      "src/wiki/snapshot.ts",
      "src/wiki/constants.ts",
      "src/wiki/link-candidates.ts",
      "src/wiki/link-resolution.ts",
      "src/wiki/types.ts",
    ]) {
      expect(source(path)).not.toMatch(importsIndexer);
    }
  });

  it("proves that guard can actually fail, against a module that does import the indexer", () => {
    const importsIndexer = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["'][^"']*indexer\/metadata-indexer["']/;
    expect(source("src/main/main.ts")).toMatch(importsIndexer);
  });

  it("routes the comment and math delimiters through the portable constants", () => {
    const model = source("src/renderer/comments/model.ts");
    expect(model).toContain("wiki/constants");
    expect(model).toContain("COMMENT_DELIMITER");
    expect(model).toContain("MATH_BLOCK_DELIMITER");
  });
});
