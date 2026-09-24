import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Bundle `geode-wiki`.
 *
 * ## Why this is bundled rather than run from source
 *
 * The package export map resolves `./wiki` to TypeScript source, and Node 26
 * strips types natively, so the obvious thing to try is a `bin` pointing
 * straight at `src/cli/main.ts`. It does not work, and the reason is worth
 * writing down so nobody re-derives it:
 *
 * - The package is `"type": "commonjs"`, so a `.ts` file under it loads as
 *   CommonJS. CommonJS cannot contain `import` statements, and the engine's
 *   modules are written in ESM syntax.
 * - Renaming the entry to `.mts` makes it ESM, but ESM demands explicit file
 *   extensions, and every module inside `src/wiki/` imports its neighbours
 *   extensionlessly (`./folder-provider`). Those resolve under CommonJS rules
 *   and not under ESM's.
 * - Importing `src/wiki/index.ts` from an ESM entry loads it as CommonJS, where
 *   named exports are discovered by `cjs-module-lexer` — which does not
 *   recognise the `export const` that type stripping leaves behind. Observed:
 *   `SyntaxError: The requested module … does not provide an export named
 *   'DEFAULT_WIKI_LIMITS'`.
 *
 * Bundling sidesteps all three and is what every existing proof in this repo
 * already does. The cost is honest and stated in the design doc: the `bin` is a
 * build artifact, so `npm run build:cli` is a prerequisite for invoking it.
 *
 * The builder is exported so that `scripts/run-wiki-cli-proof.mjs` audits and
 * executes a bundle produced by *these exact options*, rather than a
 * second-best replica of them that could drift.
 */
export async function buildCli({ outfile, metafile = true }) {
  await mkdir(dirname(outfile), { recursive: true });
  const result = await build({
    entryPoints: [resolve(fileURLToPath(new URL("../src/cli/main.ts", import.meta.url)))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    metafile,
    // The shebang has to be the first bytes of the file, so it leads the
    // banner. `createRequire` follows for parity with every other proof bundle.
    banner: {
      js: "#!/usr/bin/env node\n"
        + "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  await chmod(outfile, 0o755);
  return result;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const outfile = resolve("dist/cli/geode-wiki.mjs");
  await buildCli({ outfile });
  console.log(outfile);
}
