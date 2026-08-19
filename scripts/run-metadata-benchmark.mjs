import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const resultDir = path.resolve(process.cwd(), ".benchmark-results");
const output = path.join(resultDir, "benchmark-run.mjs");
await fsp.mkdir(resultDir, { recursive: true });
await build({
  entryPoints: [path.resolve("scripts/benchmark-metadata-index.mts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node22",
  sourcemap: false,
});
process.argv = [process.argv[0], output, ...process.argv.slice(2)];
await import(`${pathToFileURL(output).href}?run=${Date.now()}`);
