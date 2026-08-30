import esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  target: "es2022",
};

const mobileBoundaryPlugin = {
  name: "mobile-platform-boundary",
  setup(build) {
    build.onResolve({ filter: /^(electron|node:)/ }, (args) => ({
      errors: [{ text: `Mobile renderer cannot import ${args.path}` }],
    }));
    build.onEnd(async (result) => {
      const inputs = Object.keys(result.metafile?.inputs ?? {});
      const forbidden = inputs.filter((input) =>
        input.includes("src/main/") || input.endsWith("/electron-host.ts")
      );
      if (forbidden.length) {
        return { errors: [{ text: `Mobile renderer crossed the platform boundary: ${forbidden.join(", ")}` }] };
      }
      if (result.errors.length === 0) {
        await mkdir("dist/mobile", { recursive: true });
        await Promise.all([
          copyFile("src/renderer/mobile.html", "dist/mobile/index.html"),
          copyFile("styles/app.css", "dist/mobile/app.css"),
        ]);
      }
    });
  },
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
    entryPoints: ["src/renderer/desktop.ts"],
    outfile: "dist/renderer.js",
    platform: "browser",
    format: "iife",
  },
  {
    ...common,
    entryPoints: ["src/renderer/mobile.ts"],
    outfile: "dist/mobile/mobile-renderer.js",
    platform: "browser",
    format: "iife",
    metafile: true,
    plugins: [mobileBoundaryPlugin],
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

const selectedBuilds = process.argv.includes("--mobile-only")
  ? builds.filter((build) => build.entryPoints?.includes("src/renderer/mobile.ts"))
  : builds;

if (watch) {
  const contexts = await Promise.all(selectedBuilds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(selectedBuilds.map((b) => esbuild.build(b)));
}
