import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("validates and refuses publications and restores in a fresh Node process with no database and an audited input graph", () => {
  const output = execFileSync(process.execPath, ["scripts/run-catalog-contract-proof.mjs"], { encoding: "utf8" });
  const [proof, dependencies] = output.trim().split("\n").map((line) => JSON.parse(line));

  expect(proof).toEqual({
    nodeOnly: true,
    databaseFree: true,
    notes: 2,
    assets: 1,
    // Measured from the fixture, so a contract that stopped counting bytes
    // would change this rather than still print the same constant.
    totalBytes: 125,
    refusalsObserved: 20,
    distinctStatuses: 15,
    storeContactedAfterRefusal: false,
    // The restore side is refused on the same terms, and — the point of this
    // proof — with no database anywhere in the process.
    restoreRefusalsObserved: 21,
    restoreDistinctStatuses: 17,
    restoreSourceContactedAfterRefusal: false,
  });

  // The portable contract reaches exactly one other engine module, and no
  // adapter. This is the assertion that would catch the catalog quietly
  // acquiring a database dependency.
  expect(dependencies.runtimeSources).toEqual(["src/wiki/catalog-contract.ts", "src/wiki/link-candidates.ts"]);
  expect(dependencies.adapterInPortableGraph).toBe(false);
  expect(dependencies.runtimeSources.some((path: string) => path.startsWith("src/catalog/"))).toBe(false);
  expect(dependencies.runtimeSources.some((path: string) => path.startsWith("src/renderer/"))).toBe(false);
});
