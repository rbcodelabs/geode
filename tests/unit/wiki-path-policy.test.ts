import { describe, expect, it } from "vitest";
import {
  normalizeWikiPath,
  selectLinkCandidates,
  type CandidateProvider,
  type CandidateSelection,
  type LinkResolutionPolicy,
} from "../../src/wiki/link-candidates";

/**
 * Side-by-side coverage of the two resolution policies over one shared fixture.
 *
 * The row-by-row source of truth is the policy table in
 * `docs/design/shared-engine-desktop-resolution.md`. Existing suites cover the
 * strict policy thoroughly and the desktop policy incidentally; the point here
 * is that every documented divergence is asserted on BOTH policies at once, so
 * a change that quietly collapses one into the other cannot pass.
 */

const FILES = [
  "Target.md",
  "Note.md",
  "folder/Source.md",
  "folder/Local.md",
  "folder/Target.md",
  "a/Twin.md",
  "b/Twin.md",
  "deep/folder/Twin.md",
  "Alias.md",
  "Aliased.md",
  // Stored NFC ("é" as one code point).
  "Caf\u00e9.md",
];

const ALIASES: Record<string, string[]> = {
  // Insertion order matters: desktop takes the first indexed entry.
  nickname: ["Aliased.md", "Alias.md"],
};

const basenameKey = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "").normalize("NFC").toLowerCase();

function makeProvider(files: readonly string[] = FILES): CandidateProvider {
  const present = new Set(files);
  const byBasename = new Map<string, string[]>();
  for (const path of files) {
    const key = basenameKey(path);
    byBasename.set(key, [...(byBasename.get(key) ?? []), path]);
  }
  return {
    getFileByPath: (path) => (present.has(path) ? { path } : null),
    byBasename,
    byAlias: new Map(Object.entries(ALIASES)),
  };
}

const select = (target: string, source: string, policy: LinkResolutionPolicy): CandidateSelection =>
  selectLinkCandidates(target, source, makeProvider(), policy);

const desktop = (target: string, source = "folder/Source.md"): CandidateSelection =>
  select(target, source, "desktop-compatibility");
const strict = (target: string, source = "folder/Source.md"): CandidateSelection =>
  select(target, source, "agent-strict");

describe("normalizeWikiPath", () => {
  it("resolves interior traversal and no-op segments", () => {
    expect(normalizeWikiPath("a/b/../c")).toBe("a/c");
    expect(normalizeWikiPath("a/./b")).toBe("a/b");
    expect(normalizeWikiPath("a//b")).toBe("a/b");
    expect(normalizeWikiPath("a/b/")).toBe("a/b");
  });

  it("rejects every escape and non-portable form", () => {
    for (const input of [
      "",
      "..",
      "../Target",
      "a/../../Target",
      "/Target",
      "C:/Target",
      "C:Target",
      "a\\b",
      "x\0y",
      ".",
      "./",
    ]) {
      expect(normalizeWikiPath(input)).toBeNull();
    }
  });
});

describe("policy row: empty target resolves to self", () => {
  it.each(["desktop-compatibility", "agent-strict"] as const)("%s", (policy) => {
    expect(select("", "folder/Source.md", policy)).toEqual({
      candidates: ["folder/Source.md"],
      stage: "self",
    });
  });
});

describe("policy row: exact/extension priority is identical in both modes", () => {
  it.each(["desktop-compatibility", "agent-strict"] as const)("%s prefers literal identity, then .md", (policy) => {
    expect(select("Target.md", "folder/Source.md", policy)).toEqual({
      candidates: ["Target.md"],
      stage: "exact",
    });
    expect(select("Target", "folder/Source.md", policy)).toEqual({
      candidates: ["Target.md"],
      stage: "exact",
    });
  });
});

describe('policy row: explicit "./" and "../"', () => {
  // The behaviour the package calls out by name as must-not-regress.
  it("desktop runs the full legacy chain for an explicit relative target, ending at the alias stage", () => {
    // Desktop never enters the relative-only branch. It carries the literal
    // "./" prefix through every stage, so the basename key is "./twin" — which
    // matches no bucket — and the chain runs all the way to alias before
    // giving up. Empty, but for a different reason than strict.
    const result = desktop("./Twin");
    expect(result.stage).toBe("alias");
    expect(result.candidates).toEqual([]);
    expect(result.invalid).toBeUndefined();
  });

  it("strict isolates an explicit relative target: it stops at the relative stage", () => {
    // Same empty result, reached by short-circuit rather than exhaustion. This
    // is what "a missing explicit relative target never falls back to a
    // basename elsewhere" buys: the stage is the evidence.
    const result = strict("./Twin");
    expect(result.stage).toBe("relative");
    expect(result.candidates).toEqual([]);
    expect(result.invalid).toBeUndefined();
  });

  it("only strict actually resolves an explicit relative target that exists", () => {
    // The sharpest difference: desktop's literal "folder/./Local" lookup misses
    // a file strict finds by normalizing. Recorded as a known desktop gap in
    // docs/design/headless-phase0.md; pinned here so it cannot change silently.
    expect(strict("./Local").candidates).toEqual(["folder/Local.md"]);
    expect(desktop("./Local").candidates).toEqual([]);
  });

  it("strict resolves an explicit relative target against the source folder", () => {
    expect(strict("./Local")).toEqual({ candidates: ["folder/Local.md"], stage: "relative" });
    expect(strict("../Target")).toEqual({ candidates: ["Target.md"], stage: "relative" });
  });

  it("strict rejects an explicit relative target that escapes the root", () => {
    expect(strict("../../Target")).toEqual({ candidates: [], stage: "relative", invalid: "traversal" });
  });

  it("desktop does not report traversal for the same escaping target — it just finds nothing exact", () => {
    // Literal lookup, no normalization, so no traversal verdict is ever formed.
    const result = desktop("../../Target");
    expect(result.invalid).toBeUndefined();
    expect(result.candidates).toEqual([]);
  });
});

describe("policy row: relative fallback", () => {
  it("desktop prefixes the source folder literally", () => {
    expect(desktop("Local")).toEqual({ candidates: ["folder/Local.md"], stage: "relative" });
  });

  it("strict prefixes the source folder and normalizes components", () => {
    expect(strict("Local")).toEqual({ candidates: ["folder/Local.md"], stage: "relative" });
  });

  it("both prefer an exact root match over the source-folder sibling", () => {
    // "Target.md" and "folder/Target.md" both exist; the exact stage wins first.
    expect(desktop("Target").candidates).toEqual(["Target.md"]);
    expect(strict("Target").candidates).toEqual(["Target.md"]);
  });
});

describe("policy row: basename bucket and ambiguity", () => {
  it("desktop collapses ambiguity to a single shortest path", () => {
    const result = desktop("Twin", "Note.md");
    expect(result.stage).toBe("basename");
    expect(result.candidates).toEqual(["a/Twin.md"]);
  });

  it("strict surfaces the whole ambiguous bucket, lexically sorted", () => {
    const result = strict("Twin", "Note.md");
    expect(result.stage).toBe("basename");
    expect(result.candidates).toEqual(["a/Twin.md", "b/Twin.md", "deep/folder/Twin.md"]);
  });

  it("the two policies disagree on the same input — that difference is the contract", () => {
    expect(desktop("Twin", "Note.md").candidates.length).toBe(1);
    expect(strict("Twin", "Note.md").candidates.length).toBe(3);
  });
});

describe("policy row: alias bucket", () => {
  it("desktop takes the first indexed alias entry only", () => {
    const result = desktop("nickname", "Note.md");
    expect(result.stage).toBe("alias");
    expect(result.candidates).toEqual(["Aliased.md"]);
  });

  it("strict returns every alias candidate, sorted", () => {
    const result = strict("nickname", "Note.md");
    expect(result.stage).toBe("alias");
    expect(result.candidates).toEqual(["Alias.md", "Aliased.md"]);
  });
});

describe("policy row: index key normalization", () => {
  const NFD = "Cafe\u0301"; // "e" + combining acute
  const NFC = "Caf\u00e9";

  it("both match a basename that is already in the stored normal form", () => {
    expect(desktop(NFC, "Note.md").candidates).toEqual(["Caf\u00e9.md"]);
    expect(strict(NFC, "Note.md").candidates).toEqual(["Caf\u00e9.md"]);
  });

  it("only strict folds a decomposed target onto the composed index key", () => {
    expect(strict(NFD, "Note.md").candidates).toEqual(["Caf\u00e9.md"]);
    // Desktop lowercases but does not normalize, so the decomposed form misses.
    expect(desktop(NFD, "Note.md").candidates).toEqual([]);
  });

  it("both are case-insensitive at the basename stage", () => {
    expect(desktop("tWiN", "Note.md").candidates).toEqual(["a/Twin.md"]);
    expect(strict("tWiN", "Note.md").candidates).toEqual(["a/Twin.md", "b/Twin.md", "deep/folder/Twin.md"]);
  });
});

describe("policy row: non-portable targets", () => {
  it.each([
    ["/Target", "absolute"],
    ["C:/Target", "drive-absolute"],
    ["C:Target", "drive-relative"],
    ["a\\b", "backslash"],
    ["x\0y", "NUL"],
  ])("strict rejects %s (%s) as an invalid target", (target) => {
    expect(strict(target, "Note.md")).toEqual({ candidates: [], stage: "exact", invalid: "invalid-target" });
  });

  it.each(["/Target", "C:/Target", "C:Target", "a\\b", "x\0y"])(
    "desktop never forms an invalid-target verdict for %s",
    (target) => {
      // Desktop hands the literal string to the adapter; classification is not
      // its job. Preserved deliberately — plugins depend on the literal lookup.
      expect(desktop(target, "Note.md").invalid).toBeUndefined();
    },
  );
});

describe("policy row: root-anchored source path", () => {
  // The two policies form the source's parent folder differently: desktop
  // requires the slash at index > 0, strict also accepts index 0. Either way a
  // root-anchored source yields no usable relative candidate — desktop because
  // it forms no parent at all, strict because the normalized "/Local" is
  // rejected as absolute — so both fall through to the basename bucket.
  it.each(["desktop-compatibility", "agent-strict"] as const)(
    "%s declines the relative stage and falls through to basename",
    (policy) => {
      const result = selectLinkCandidates("Local", "/Note.md", makeProvider(), policy);
      expect(result.stage).toBe("basename");
      expect(result.candidates).toEqual(["folder/Local.md"]);
    },
  );
});

describe("policy row: selector stripping is the wrapper's job, not the selector's", () => {
  it("neither policy strips a subpath selector itself", () => {
    // `#`/`^` are removed by resolveFirstLinkpathDest / the strict snapshot
    // wrapper before this function is reached. Passing one through unchanged
    // must therefore miss, in both modes — that is what keeps subpath
    // diagnostics owned by the wrapper rather than silently swallowed here.
    expect(desktop("Target#Heading", "Note.md").candidates).toEqual([]);
    expect(strict("Target#Heading", "Note.md").candidates).toEqual([]);
  });
});
