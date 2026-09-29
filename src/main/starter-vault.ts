/**
 * Copies the bundled `resources/starter-vault/` content into a destination
 * folder so the "Try the sample vault" picker button (src/renderer/app.ts's
 * `showVaultPicker`) has somewhere to open. `resources/starter-vault/` is a
 * content-only prototype (PR #285) already shipped inside every packaged
 * build via electron-builder's `files: ["resources/**\/*"]` — this module is
 * the first thing that actually reads it at runtime.
 *
 * Modeled on ./builtin-themes.ts's `packagedResourcesDir()` convention:
 * esbuild bundles main-process code to `dist/main.js`, so `__dirname` is
 * `<repo>/dist` at runtime in both dev and packaged builds, and
 * `GEODE_RESOURCES_DIR` overrides it for tests exactly as it does there.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";

function packagedResourcesDir(): string {
  return process.env.GEODE_RESOURCES_DIR || path.join(__dirname, "..", "resources");
}

/**
 * Recursively copies `<resourcesDir>/starter-vault` into `destRoot`.
 *
 * Deliberately does not use `fs.promises.cp` — that's a newer, more complex
 * API not proven safe against this app's asar-packaged resources. This walk
 * uses the same `fsp.readdir`/`fsp.readFile` idiom builtin-themes.ts already
 * relies on to read out of a packaged asar archive. Files are read/written as
 * `Buffer`s (never decoded as utf8) so binary content — images, `.canvas`
 * JSON, anything — copies byte-for-byte.
 *
 * Inside any directory named `.geode` (at any depth under the starter vault),
 * only an `app.json` entry is copied; every other entry is skipped outright,
 * without recursing into it. `.gitignore` already narrows
 * `resources/starter-vault/.geode/*` to just `app.json` for what's tracked in
 * git, but a maintainer's local checkout can still have accumulated
 * untracked runtime state (`metadata-cache/`, `workspace.json`,
 * `community.json`, `device-reconcile:*`) from manually opening that folder
 * as a vault during development. This is the code-level guarantee that such
 * junk can never leak into a vault copied for a real user.
 */
export async function copyStarterVault(
  destRoot: string,
  resourcesDir = packagedResourcesDir(),
): Promise<void> {
  const srcRoot = path.join(resourcesDir, "starter-vault");
  await copyDir(srcRoot, destRoot, false);
}

async function copyDir(srcDir: string, destDir: string, insideGeodeDir: boolean): Promise<void> {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  await fsp.mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    if (insideGeodeDir && entry.name !== "app.json") continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, insideGeodeDir || entry.name === ".geode");
    } else if (entry.isFile()) {
      const data = await fsp.readFile(srcPath);
      await fsp.writeFile(destPath, data);
    }
  }
}
