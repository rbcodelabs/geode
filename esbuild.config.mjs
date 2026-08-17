import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  target: "es2022",
};

const builds = [
  {
    ...common,
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  },
  {
    ...common,
    entryPoints: ["src/main/preload.ts"],
    outfile: "dist/preload.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  },
  {
    ...common,
    entryPoints: ["src/indexer/indexer-process.ts"],
    outfile: "dist/indexer-process.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  },
  {
    ...common,
    entryPoints: ["src/renderer/app.ts"],
    outfile: "dist/renderer.js",
    platform: "browser",
    format: "iife",
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
