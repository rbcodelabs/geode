import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "geode-link-benchmark-"));
// Optional immutable comparison revision; no checkout or worktree mutation.
const baseline = process.argv[2];
try {
  const outfile = join(directory, "benchmark.cjs");
  const plugins = baseline ? [{ name: "baseline-source", setup(build) {
    build.onLoad({ filter: /src\/wiki\/(snapshot|link-resolution)\.ts$/ }, args => {
      const file = args.path.endsWith("/snapshot.ts") ? "snapshot.ts" : "link-resolution.ts";
      return { contents: execFileSync("git", ["show", `${baseline}:src/wiki/${file}`], { encoding: "utf8" }), loader: "ts", resolveDir: resolve("src/wiki") };
    });
  } }] : [];
  await build({ entryPoints: [resolve("scripts/benchmark-link-resolution.mts")], outfile, bundle: true, platform: "node", format: "cjs", target: "node22", plugins });
  process.stdout.write(execFileSync(process.execPath, ["--expose-gc", outfile], { encoding: "utf8" }));
} finally { await rm(directory, { recursive: true, force: true }); }
