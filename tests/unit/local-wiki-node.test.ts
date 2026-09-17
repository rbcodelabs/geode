import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("opens a real folder and exercises every snapshot operation in fresh Node with an audited input graph", () => {
  const output = execFileSync(process.execPath, ["scripts/run-local-wiki-node-proof.mjs"], { encoding: "utf8" });
  const [proof, dependencies] = output.trim().split("\n").map(line => JSON.parse(line));
  expect(proof).toEqual({ nodeOnly: true, files: 5, queryOperations: 7, duplicateCandidates: 2, snapshotDetached: true, diagnostics: true });
  expect(dependencies.runtimeSources).toContain("src/wiki/local-filesystem.ts");
  expect(dependencies.runtimeSources).toContain("src/wiki/snapshot.ts");
  // The snapshot's constants are portable now, so they appear in the graph...
  expect(dependencies.runtimeSources).toContain("src/wiki/constants.ts");
  // ...and the desktop indexer they used to come from does not.
  expect(dependencies.runtimeSources).not.toContain("src/indexer/metadata-indexer.ts");
});
