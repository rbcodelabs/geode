import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "geode-catalog-contract-bundle-"));
try {
  const outfile = join(directory, "proof.mjs");
  const result = await build({
    entryPoints: [resolve("scripts/catalog-contract-proof.mts")], outfile,
    bundle: true, platform: "node", format: "esm", target: "node22", metafile: true,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const sources = Object.keys(result.metafile.inputs).filter(path => path.startsWith("src/"));
  // The catalog contract is portable: it reaches `link-candidates` for the one
  // path normalizer the engine already owns, and nothing else. In particular
  // `src/catalog/postgres-catalog-store.ts` must be absent — the adapter is the
  // only module in the build that knows a database exists, and the portable
  // core must not reach it even through a type-only-looking import that a
  // bundler could tree-shake away. An unexpected source dependency fails here.
  const permitted = new Set([
    "src/wiki/catalog-contract.ts", "src/wiki/link-candidates.ts",
  ]);
  for (const path of sources) assert.ok(permitted.has(path), `Unexpected runtime dependency: ${path}`);
  assert.ok(
    !sources.some(path => path.startsWith("src/catalog/")),
    "the PostgreSQL adapter must not appear in the portable input graph",
  );
  process.stdout.write(execFileSync(process.execPath, [outfile], { encoding: "utf8" }));
  console.log(JSON.stringify({ runtimeSources: sources.sort(), adapterInPortableGraph: false }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
