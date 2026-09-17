import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "geode-local-wiki-write-bundle-"));
try {
  const outfile = join(directory, "proof.mjs");
  const result = await build({
    entryPoints: [resolve("scripts/local-wiki-write-proof.mts")], outfile,
    bundle: true, platform: "node", format: "esm", target: "node22", metafile: true,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const sources = Object.keys(result.metafile.inputs).filter(path => path.startsWith("src/"));
  // The write path pulls in `folder-provider` and `contracts` on top of the
  // read-only set, plus `search` for the portable query primitives.
  // `src/indexer/metadata-indexer.ts` stays out: the scan-cap constant lives in
  // `src/wiki/constants.ts`, so nothing portable reaches into the desktop
  // indexer. An unexpected source dependency fails here even if a bundler
  // could tree-shake it away.
  const permitted = new Set([
    "src/wiki/folder-provider.ts", "src/wiki/contracts.ts", "src/wiki/search.ts",
    "src/wiki/local-filesystem.ts", "src/wiki/snapshot.ts", "src/wiki/metadata.ts",
    "src/wiki/link-candidates.ts", "src/wiki/constants.ts",
    "src/renderer/comments/model.ts", "src/renderer/api/frontmatter.ts",
  ]);
  for (const path of sources) assert.ok(permitted.has(path), `Unexpected runtime dependency: ${path}`);
  process.stdout.write(execFileSync(process.execPath, [outfile], { encoding: "utf8" }));
  console.log(JSON.stringify({ runtimeSources: sources.sort() }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
