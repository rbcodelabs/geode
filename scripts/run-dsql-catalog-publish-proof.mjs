import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

/**
 * The DSQL publish proof, standalone.
 *
 * Same role as `run-catalog-publish-proof.mjs`: bundle VM A, audit its complete
 * esbuild input graph, then run it against a schema and object store it creates
 * and destroys itself. The two-process restore harness is a separate, larger
 * run; this is the one to reach for when the question is only about publish
 * semantics and the optimistic-concurrency behaviour.
 */

const directory = await mkdtemp(join(tmpdir(), "geode-dsql-publish-bundle-"));
try {
  const outfile = join(directory, "proof.mjs");
  const result = await build({
    entryPoints: [resolve("scripts/dsql-catalog-publish-proof.mts")], outfile,
    bundle: true, platform: "node", format: "esm", target: "node22", metafile: true,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const sources = Object.keys(result.metafile.inputs).filter((path) => path.startsWith("src/")).sort();
  // VM A is allowed to contain the adapter, because it is the thing under test.
  // Everything else it pulls in is the portable engine. `proof:catalog` is what
  // proves the portable core does not reach the other way.
  const permitted = new Set([
    "src/catalog/dsql-catalog-store.ts", "src/catalog/object-store.ts",
    "src/wiki/catalog-contract.ts", "src/wiki/folder-provider.ts", "src/wiki/contracts.ts",
    "src/wiki/local-filesystem.ts", "src/wiki/snapshot.ts", "src/wiki/metadata.ts",
    "src/wiki/link-candidates.ts", "src/wiki/constants.ts", "src/wiki/query-projection.ts",
    "src/renderer/comments/model.ts", "src/renderer/api/frontmatter.ts",
  ]);
  for (const path of sources) assert.ok(permitted.has(path), `Unexpected runtime dependency: ${path}`);
  assert.deepEqual(
    sources.filter((path) => path.startsWith("src/catalog/")),
    ["src/catalog/dsql-catalog-store.ts", "src/catalog/object-store.ts"],
    "exactly the DSQL adapter and its object store may know where durable state lives",
  );
  assert.equal(
    sources.includes("src/catalog/postgres-catalog-store.ts"), false,
    "the PostgreSQL adapter must not appear in a DSQL build",
  );
  process.stdout.write(execFileSync(process.execPath, [outfile], { encoding: "utf8" }));
  console.log(JSON.stringify({ runtimeSources: sources }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
