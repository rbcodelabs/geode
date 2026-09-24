import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("drives the whole engine through the SDK alone in a fresh Node process with an audited input graph", () => {
  const output = execFileSync(process.execPath, ["scripts/run-wiki-sdk-proof.mjs"], { encoding: "utf8" });
  const [proof, dependencies] = output.trim().split("\n").map((line) => JSON.parse(line));

  // Every field below is a sequence the proof measured as it went. A session
  // that stopped applying writes, or stopped showing them to the next read,
  // would change these rather than still printing the same constants.
  expect(proof).toEqual({
    nodeOnly: true,
    runtimeExports: ["DEFAULT_WIKI_LIMITS", "openWikiSession"],
    sessionMethods: 11,
    snapshotHandleReachable: false,
    // Target.md's backlinks: none, then one once the referrer is created, then
    // none again once the update retargets it.
    backlinkCounts: [0, 1, 0],
    // "plesiosaur" matches once after the create and not after the update
    // replaced it; "ichthyosaur" no longer matches after the delete.
    searchCounts: [1, 0, 0],
    // 3 seeded, 4 after the create, 3 after the delete, 4 again once a refresh
    // picks up a note written outside the session.
    fileCounts: [3, 4, 3, 4],
    resolutions: {
      unique: "resolved", ambiguous: "ambiguous", ambiguousCandidates: 2,
      missing: "missing", alias: "resolved",
    },
    refusals: 9,
  });

  // The audited graph, asserted exactly. `src/wiki/search.ts` and
  // `src/wiki/link-resolution.ts` are the two absences that carry the most
  // meaning: the first is the desktop operator query language, the second the
  // desktop-compatibility resolver that tie-breaks ambiguity. Either appearing
  // here would mean two contradictory contracts shipped under one surface.
  expect(dependencies.runtimeSources).toEqual([
    "src/renderer/api/frontmatter.ts",
    "src/renderer/comments/model.ts",
    "src/wiki/constants.ts",
    "src/wiki/folder-provider.ts",
    "src/wiki/index.ts",
    "src/wiki/link-candidates.ts",
    "src/wiki/local-filesystem.ts",
    "src/wiki/metadata.ts",
    "src/wiki/snapshot.ts",
  ]);
});
