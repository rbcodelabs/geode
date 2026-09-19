import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("drives the real binary in real subprocesses, with an enforced layering", () => {
  const output = execFileSync(process.execPath, ["scripts/run-wiki-cli-proof.mjs"], { encoding: "utf8" });
  const [proof, graph] = output.trim().split("\n").map((line) => JSON.parse(line));

  expect(proof).toEqual({
    realSubprocesses: true,
    // All four documented codes observed in one run, so the scheme is proven
    // whole rather than one branch at a time.
    exitCodesObserved: { ok: 0, refused: 1, usage: 2, unavailable: 3 },
    // create, read-back, search, delete, read-again — five processes, five
    // PIDs. This is the property a long-lived session would have satisfied
    // from its own heap and therefore never actually tested.
    distinctPidsInConsistencyRun: 5,
    crossProcessReadAfterWrite: true,
    resolutionVocabulary: {
      resolved: "resolved",
      ambiguous: "ambiguous",
      ambiguousCandidates: 2,
      missing: "missing",
      // The sharp one: a link whose *source* was never walked is `unavailable`,
      // not `missing`. Collapsing the two would tell a caller a note is not
      // there when the truth is that it was never looked at.
      notScanned: "unavailable",
      alias: "resolved",
    },
    writeRefusals: 7,
    distinctWriteRefusalStatuses: 5,
    usageCases: 10,
    catalogRefusalsWithoutADatabase: 2,
    incompleteCaptureAdmitted: true,
  });

  // The layering, asserted exactly. `src/wiki/search.ts`,
  // `src/wiki/link-resolution.ts` and `src/wiki/query-projection.ts` are the
  // absences that carry meaning — the desktop operator query language, the
  // desktop-compatibility resolver, and the restore-equality test oracle.
  expect(graph.runtimeSources).toEqual([
    "src/catalog/index.ts",
    "src/catalog/postgres-catalog-store.ts",
    "src/cli/geode-wiki.ts",
    "src/cli/main.ts",
    "src/cli/output.ts",
    "src/renderer/api/frontmatter.ts",
    "src/renderer/comments/model.ts",
    "src/wiki/catalog-contract.ts",
    "src/wiki/catalog-materialize.ts",
    "src/wiki/constants.ts",
    "src/wiki/folder-provider.ts",
    "src/wiki/index.ts",
    "src/wiki/link-candidates.ts",
    "src/wiki/local-filesystem.ts",
    "src/wiki/metadata.ts",
    "src/wiki/snapshot.ts",
  ]);
  expect(graph.cliModules).toEqual([
    "src/cli/geode-wiki.ts", "src/cli/main.ts", "src/cli/output.ts",
  ]);
  // Two minutes, not vitest's default five seconds. This proof bundles the CLI
  // and then spawns roughly forty separate `geode-wiki` processes — which is
  // the point of it, and is inherently slower than an in-process test. It
  // finishes in about four seconds on an idle machine and tripped the default
  // when the rest of the suite was running alongside it.
}, 120_000);
