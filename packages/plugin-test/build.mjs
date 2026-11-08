import { build } from "esbuild";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
// Optional deps that may be absent from a checkout; the harness never exercises them.
const external = ["qrcode-generator", "jsqr"].filter((m) => !existsSync(resolve(root, "node_modules", m)));
await build({
  entryPoints: [resolve(here, "src/browser-entry.ts")],
  outfile: resolve(here, "dist/harness.js"),
  bundle: true, format: "iife", platform: "browser", target: "chrome120", sourcemap: false,
  external, logLevel: "warning",
  define: { "process.env.NODE_ENV": '"test"' },
});
console.log("built dist/harness.js", external.length ? `(external: ${external.join(", ")})` : "");
