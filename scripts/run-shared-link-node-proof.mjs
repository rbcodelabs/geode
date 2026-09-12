import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "geode-shared-link-proof-"));
try {
  const outfile = join(directory, "proof.cjs");
  const result = await build({ entryPoints: [resolve("scripts/shared-link-node-proof.mts")], outfile, bundle: true, platform: "node", format: "cjs", target: "node22", metafile: true });
  const sources = Object.keys(result.metafile.inputs).filter(path => path.startsWith("src/"));
  const allowed = new Set(["src/wiki/link-candidates.ts", "src/wiki/link-resolution.ts", "src/wiki/snapshot.ts", "src/wiki/metadata.ts", "src/indexer/metadata-indexer.ts", "src/renderer/comments/model.ts", "src/renderer/api/frontmatter.ts"]);
  for (const source of sources) assert.ok(allowed.has(source), `Unexpected runtime dependency: ${source}`);
  process.stdout.write(execFileSync(process.execPath, [outfile], { encoding: "utf8" }));
} finally { await rm(directory, { recursive: true, force: true }); }
