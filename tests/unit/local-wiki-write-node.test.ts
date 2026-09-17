import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("creates, updates and deletes real notes in a fresh Node process with an audited input graph", () => {
  const output = execFileSync(process.execPath, ["scripts/run-local-wiki-write-proof.mjs"], { encoding: "utf8" });
  const [proof, dependencies] = output.trim().split("\n").map((line) => JSON.parse(line));

  expect(proof).toEqual({
    nodeOnly: true,
    created: 1,
    updated: 1,
    deleted: 1,
    refusals: 8,
    events: 3,
    backlinksObserved: true,
    searchObserved: true,
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
