import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { expect, it } from "vitest";

const root = resolve(__dirname, "../../src/sync-core");
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : name.endsWith(".ts") ? [join(dir, name)] : []);
const specifiers = (source: string) => [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"`;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]);
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

it("src/sync-core has files to audit", () => { expect(files(root).length).toBeGreaterThanOrEqual(6); });

it("src/sync-core imports only itself, src/shared, and no platform packages", () => {
  for (const file of files(root)) {
    for (const spec of specifiers(stripComments(readFileSync(file, "utf8")))) {
      expect(spec, file).not.toMatch(/^(electron|node:|fs|path|os|child_process)(\/|$)/);
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        const ok = target.startsWith(root + "/") || target.startsWith(resolve(root, "../shared") + "/");
        expect(ok, `${file} imports ${spec}`).toBe(true);
      }
    }
  }
});

it("src/sync-core never touches DOM or Electron globals", () => {
  for (const file of files(root)) {
    const source = stripComments(readFileSync(file, "utf8"));
    expect(source, file).not.toMatch(/\b(document|window|localStorage|sessionStorage|navigator|ipcRenderer|ipcMain)\s*[.[]/);
    expect(source, file).not.toMatch(/\bnew\s+(?:Worker|XMLHttpRequest)\b|\bfetch\(/);
  }
});

it("src/shared modules reached from sync-core stay platform-neutral", () => {
  for (const name of ["portable-assets.ts", "sync-safety.ts"]) {
    const source = stripComments(readFileSync(resolve(root, "../shared", name), "utf8"));
    expect(specifiers(source).filter(spec => spec.startsWith(".") && !spec.startsWith("./")), name).toEqual([]);
  }
});
