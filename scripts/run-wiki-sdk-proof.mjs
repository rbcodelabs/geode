import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "geode-wiki-sdk-bundle-"));
try {
  const outfile = join(directory, "proof.mjs");
  const result = await build({
    entryPoints: [resolve("scripts/wiki-sdk-proof.mts")], outfile,
    bundle: true, platform: "node", format: "esm", target: "node22", metafile: true,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const sources = Object.keys(result.metafile.inputs).filter(path => path.startsWith("src/")).sort();

  // The named boundaries run FIRST, so crossing one reports which boundary was
  // crossed rather than only "the set differs". The exact-set check below then
  // catches everything these do not anticipate.
  //
  // `src/wiki/search.ts` is the sharpest of these: it holds the desktop search
  // view's operator query language, which is a *different* search contract from
  // the bounded literal scan the SDK exposes (ADR 0020 records that the two are
  // deliberately not converged). Its presence here would mean two search
  // semantics had been shipped under one surface.
  //
  // `src/wiki/link-resolution.ts` is the second: it is the
  // desktop-compatibility resolver, which silently tie-breaks ambiguity. The
  // SDK answers under agent-strict policy, which reports it. One SDK must not
  // carry both answers.
  const forbidden = {
    "the desktop operator query language": ["src/wiki/search.ts"],
    "the desktop-compatibility link resolver": ["src/wiki/link-resolution.ts"],
    "the catalog contract and its adapter": [
      "src/wiki/catalog-contract.ts", "src/wiki/catalog-materialize.ts",
    ],
    "the restore-equality test oracle": ["src/wiki/query-projection.ts"],
  };
  for (const [description, paths] of Object.entries(forbidden)) {
    for (const path of paths) {
      assert.ok(!sources.includes(path), `${description} must not be in the SDK graph: ${path}`);
    }
  }
  // `src/cli/` is here for the mirror image of the reason the others are. The
  // command layer is a *consumer* of this SDK, and that dependency has to point
  // one way: an engine module reaching back into argument parsing or output
  // formatting would make the SDK unusable by anything that is not a terminal.
  // `scripts/run-wiki-cli-proof.mjs` enforces the other half — that nothing
  // under `src/cli/` reaches past this entry point.
  for (const prefix of ["src/catalog/", "src/cli/", "src/indexer/", "src/main/", "src/preload/"]) {
    assert.ok(
      !sources.some(path => path.startsWith(prefix)),
      `nothing under ${prefix} may reach the SDK graph`,
    );
  }
  // The only renderer modules permitted are the two portable parser helpers the
  // metadata parser still borrows. Anything else means the SDK found its way to
  // host services.
  assert.deepEqual(
    sources.filter(path => path.startsWith("src/renderer/")),
    ["src/renderer/api/frontmatter.ts", "src/renderer/comments/model.ts"],
    "the SDK must borrow exactly two portable renderer helpers and no more",
  );

  // EXACT, not a permitted superset. The SDK's whole claim is that it is a
  // narrowing, so the audit has to fail on a module that appears *and* on one
  // that quietly disappears — a superset check only catches the first.
  assert.deepEqual(sources, [
    "src/renderer/api/frontmatter.ts",
    "src/renderer/comments/model.ts",
    "src/wiki/constants.ts",
    "src/wiki/folder-provider.ts",
    "src/wiki/index.ts",
    "src/wiki/link-candidates.ts",
    "src/wiki/local-filesystem.ts",
    "src/wiki/metadata.ts",
    "src/wiki/snapshot.ts",
  ], "the SDK input graph must be exactly the audited set");

  process.stdout.write(execFileSync(process.execPath, [outfile], { encoding: "utf8" }));
  console.log(JSON.stringify({ runtimeSources: sources }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
