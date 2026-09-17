import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("creates, updates and deletes real notes in a fresh Node process with an audited input graph", () => {
  const output = execFileSync(process.execPath, ["scripts/run-local-wiki-write-proof.mjs"], { encoding: "utf8" });
  const [proof, dependencies] = output.trim().split("\n").map((line) => JSON.parse(line));

  // Each field is a sequence the proof measured as it went, so a provider that
  // stopped applying writes would change these rather than still printing the
  // same constants.
  expect(proof).toEqual({
    nodeOnly: true,
    // Target.md's backlinks: none, then one once the referrer is created, then
    // none again once the update retargets it at Other.md.
    backlinkCounts: [0, 1, 0],
    // "plesiosaur" matches once after create and not after the update replaced
    // it; "ichthyosaur" no longer matches after the delete.
    searchCounts: [1, 0, 0],
    // 1 seeded note, 2 after the create, still 2 after the delete because the
    // mid-run refresh picked up Other.md.
    fileCounts: [1, 2, 2],
    eventTypes: ["created", "updated", "deleted"],
    refusals: 8,
  });

  expect(dependencies.runtimeSources).toContain("src/wiki/folder-provider.ts");
  expect(dependencies.runtimeSources).toContain("src/wiki/search.ts");
  // The write path must not drag the desktop indexer back into the graph.
  expect(dependencies.runtimeSources).not.toContain("src/indexer/metadata-indexer.ts");
  // Nor anything from the renderer beyond the two portable helpers the parser
  // still borrows. This is the assertion that would catch a provider quietly
  // reaching for host services.
  const renderer = dependencies.runtimeSources.filter((path: string) => path.startsWith("src/renderer/"));
  expect(renderer.sort()).toEqual(["src/renderer/api/frontmatter.ts", "src/renderer/comments/model.ts"]);
});
