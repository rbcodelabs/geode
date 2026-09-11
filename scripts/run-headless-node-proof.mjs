import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "geode-headless-bundle-"));
try {
  const outfile = join(directory, "proof.mjs");
  const result = await build({
    entryPoints: [resolve("scripts/headless-node-proof.mts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    metafile: true,
    // yaml's CommonJS build imports Node builtins from the ESM bundle.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const sources = Object.keys(result.metafile.inputs).filter((path) => path.startsWith("src/"));
  const permitted = new Set([
    "src/wiki/metadata.ts", "src/wiki/link-resolution.ts", "src/wiki/link-candidates.ts",
    "src/renderer/comments/model.ts", "src/renderer/api/frontmatter.ts",
    "src/indexer/metadata-indexer.ts",
  ]);
  for (const path of sources) assert.ok(permitted.has(path), `Unexpected runtime dependency: ${path}`);
  process.stdout.write(execFileSync(process.execPath, [outfile], { encoding: "utf8" }));
  console.log(JSON.stringify({ runtimeSources: sources.sort() }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
