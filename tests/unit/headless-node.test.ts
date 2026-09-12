import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("uses real parser and injected resolver in a fresh Node process with a bounded dependency graph", () => {
  const output = execFileSync(process.execPath, ["scripts/run-headless-node-proof.mjs"], { encoding: "utf8" });
  const [proof, dependencies] = output.trim().split("\n").map((line) => JSON.parse(line));
  expect(proof).toEqual({ nodeOnly: true, notes: 2, resolvedReferences: 3, missingTarget: null });
  expect(dependencies.runtimeSources).toContain("src/wiki/metadata.ts");
  expect(dependencies.runtimeSources).toContain("src/wiki/link-resolution.ts");
});
