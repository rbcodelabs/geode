// Bundles the plugin to dist/main.js and copies manifest.json beside it.
// Install: copy dist/{main.js,manifest.json} to <vault>/.geode/plugins/geode-icloud-sync/
// and add "geode-icloud-sync" to <vault>/.geode/plugins.json (the Geode plugin loader convention).
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "dist");
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [resolve(here, "src/main.ts")],
  outfile: resolve(dist, "main.js"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["geode", "obsidian", "electron"],
  logLevel: "info",
});
await copyFile(resolve(here, "manifest.json"), resolve(dist, "manifest.json"));
