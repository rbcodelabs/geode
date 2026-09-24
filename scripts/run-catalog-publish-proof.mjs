import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "geode-catalog-publish-bundle-"));
try {
  const outfile = join(directory, "proof.mjs");
  const result = await build({
    entryPoints: [resolve("scripts/catalog-publish-proof.mts")], outfile,
    bundle: true, platform: "node", format: "esm", target: "node22", metafile: true,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const sources = Object.keys(result.metafile.inputs).filter(path => path.startsWith("src/"));
  // VM A is the one graph that is *allowed* to contain the adapter, because it
  // is the thing under test. Everything else it pulls in is the portable
  // engine, reached through the same modules the read/write proofs audit. The
  // separate `run-catalog-contract-proof.mjs` audit is what proves the
  // portable core does not reach the other way.
  const permitted = new Set([
    "src/catalog/postgres-catalog-store.ts",
    "src/wiki/catalog-contract.ts", "src/wiki/folder-provider.ts", "src/wiki/contracts.ts",
    "src/wiki/local-filesystem.ts", "src/wiki/snapshot.ts", "src/wiki/metadata.ts",
    "src/wiki/link-candidates.ts", "src/wiki/constants.ts", "src/wiki/query-projection.ts",
    "src/renderer/comments/model.ts", "src/renderer/api/frontmatter.ts",
  ]);
  for (const path of sources) assert.ok(permitted.has(path), `Unexpected runtime dependency: ${path}`);
  assert.deepEqual(
    sources.filter(path => path.startsWith("src/catalog/")),
    ["src/catalog/postgres-catalog-store.ts"],
    "exactly one module in the build may know a database exists",
  );
  process.stdout.write(execFileSync(process.execPath, [outfile], { encoding: "utf8" }));
  console.log(JSON.stringify({ runtimeSources: sources.sort() }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
