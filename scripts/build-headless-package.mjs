import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, "packages/headless");
// Only this script's generated directory is removed; no source or consumer artifacts.
await rm(join(directory, "dist"), { recursive: true, force: true });
const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
for (const [name, entry] of Object.entries({ "wiki/index": "src/wiki/index.ts", "catalog/cloud": "src/catalog/cloud.ts", "documents/index": "src/documents/index.ts" })) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], outfile: join(directory, "dist", `${name}.js`),
    bundle: true, platform: "node", target: "node22", format: "esm", packages: "external", metafile: true,
  });
  for (const path of Object.keys(result.metafile.inputs)) {
    assert.ok(!/^src\/(main|preload|cli|indexer)\//.test(path), `Forbidden host dependency ${path}`);
    if (name === "wiki/index") assert.ok(!path.startsWith("src/catalog/"), `Cloud dependency reached wiki: ${path}`);
  }
  for (const output of Object.values(result.metafile.outputs)) for (const item of output.imports) {
    if (!item.external || item.path.startsWith("node:")) continue;
    const dependency = item.path.startsWith("@") ? item.path.split("/").slice(0, 2).join("/") : item.path.split("/")[0];
    assert.ok(dependency in manifest.dependencies, `Undeclared dependency ${dependency}`);
  }
}
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(directory, "tsconfig.json")], { stdio: "inherit" });
// Declaration-only Bundler output needs explicit extensions for NodeNext consumers.
async function fixDeclarations(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await fixDeclarations(file);
    else if (entry.name.endsWith(".d.ts")) {
      const text = await readFile(file, "utf8");
      await writeFile(file, text.replace(/(from\s+|import\s*\()(["'])(\.[^"']+)\2/g, (_, prefix, quote, specifier) =>
        `${prefix}${quote}${specifier.replace(/\.ts$/, "").replace(/\.js$/, "")}.js${quote}`));
    }
  }
}
await fixDeclarations(join(directory, "dist/types"));
// tsc emits implementation-only dependency declarations too. Ship only the
// declarations reachable from the supported public entries, never admin tools.
const needed = new Set();
async function retainDeclaration(file) {
  if (needed.has(file)) return;
  needed.add(file);
  const text = await readFile(file, "utf8");
  for (const imported of ts.preProcessFile(text).importedFiles) {
    if (imported.fileName.startsWith(".")) {
      await retainDeclaration(resolve(dirname(file), imported.fileName.replace(/\.js$/, ".d.ts")));
    }
  }
}
for (const entry of Object.values(manifest.exports)) await retainDeclaration(join(directory, entry.types));
async function pruneDeclarations(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await pruneDeclarations(file);
    else if (!needed.has(file)) await rm(file);
  }
}
await pruneDeclarations(join(directory, "dist/types"));
await copyFile(join(root, "LICENSE"), join(directory, "LICENSE"));
console.log(`Built ${manifest.name}@${manifest.version}`);
