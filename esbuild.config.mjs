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
  // Mermaid ships as its own chunk, injected on demand by
  // src/renderer/internal-plugins/mermaid/load-mermaid.ts. The renderer above
  // is a single-outfile IIFE, so esbuild code-splitting is not available —
  // a second entry point is what keeps several megabytes of mermaid/d3/dagre
  // out of every cold start. electron-builder already globs dist/**/*, so the
  // chunk ships with the packaged app without further config.
  {
    ...common,
    entryPoints: ["src/renderer/vendor/mermaid-entry.ts"],
    outfile: "dist/mermaid.js",
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
