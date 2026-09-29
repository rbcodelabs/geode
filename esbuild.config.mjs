import esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  target: "es2022",
};

/**
 * KaTeX's stylesheet with its fonts inlined, injected at runtime by
 * src/renderer/markdown/math-style.ts the first time math renders.
 *
 * Only the `woff2` faces are kept, as `data:` URIs: every Chromium/WebKit
 * engine Geode runs on reads woff2, the renderer CSP allows `font-src data:`,
 * and a data URI needs no asset tree that both the desktop app and the iOS
 * bundle (which resolve resources from different base directories) would have
 * to agree on. The `woff`/`ttf` fallbacks would triple the payload for no
 * reader. Throws if any font reference survives, so a KaTeX upgrade that
 * changes the stylesheet's shape fails the build rather than silently
 * shipping math with missing glyphs.
 */
function buildKatexCss() {
  const katexDist = path.dirname(createRequire(import.meta.url).resolve("katex/package.json")) + "/dist";
  const css = readFileSync(katexDist + "/katex.min.css", "utf8")
    .replace(/,url\(fonts\/[^)]+\.woff\) format\("woff"\)/g, "")
    .replace(/,url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g, "")
    .replace(/url\(fonts\/([^)]+\.woff2)\)/g, (_m, file) => {
      const font = readFileSync(katexDist + "/fonts/" + file);
      return `url(data:font/woff2;base64,${font.toString("base64")})`;
    });
  if (/url\(fonts\//.test(css)) {
    throw new Error("katex.min.css still references an unbundled font file");
  }
  return css;
}

const katexCssDefine = { __GEODE_KATEX_CSS__: JSON.stringify(buildKatexCss()) };

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
    entryPoints: ["src/renderer/audio/pcm-capture-worklet.js"],
    outfile: "dist/pcm-capture-worklet.js",
    platform: "browser",
    format: "esm",
  },
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
    entryPoints: ["src/main/webviewer-bridge-preload.ts"],
    outfile: "dist/webviewer-bridge-preload.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  },
  {
    ...common,
    entryPoints: ["src/main/agent-browser-bridge-preload.ts"],
    outfile: "dist/agent-browser-bridge-preload.js",
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
    define: katexCssDefine,
  },
  {
    ...common,
    entryPoints: ["src/renderer/mobile.ts"],
    outfile: "dist/mobile/mobile-renderer.js",
    platform: "browser",
    format: "iife",
    define: katexCssDefine,
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
