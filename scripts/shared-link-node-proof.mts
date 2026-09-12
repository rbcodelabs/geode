import assert from "node:assert/strict";
import { resolveFirstLinkpathDest } from "../src/wiki/link-resolution";
import { createWikiSnapshot } from "../src/wiki/snapshot";
import { parseMetadata } from "../src/wiki/metadata";
import { resolutionFiles, resolutionTargets } from "../tests/fixtures/shared-link-resolution";

assert.equal("window" in globalThis, false);
assert.equal("document" in globalThis, false);
assert.equal(process.versions.electron, undefined);
const entries = Object.entries(resolutionFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
const files = new Map(entries.map(([path]) => [path, { path }]));
const byBasename = new Map<string, string[]>();
const byAlias = new Map<string, string[]>();
function add(index: Map<string, string[]>, key: string, path: string) {
  const k = key.toLowerCase();
  index.set(k, [...(index.get(k) ?? []), path]);
}
for (const [path, text] of entries) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  add(byBasename, name, path);
  add(byBasename, name.replace(/\.md$/, ""), path);
  for (const alias of parseMetadata(text).aliases) add(byAlias, alias, path);
}
const provider = { getFileByPath: (path: string) => files.get(path) ?? null, byBasename, byAlias };
const snapshot = createWikiSnapshot(entries.map(([path, text]) => ({ path, text, kind: "note" })));
const source = "folder/Source.md";
const compatibility = resolutionTargets.map(target => resolveFirstLinkpathDest(target, source, provider)?.path ?? null);
const strict = resolutionTargets.map(target => snapshot.resolve(source, target));
assert.equal(strict[4].status, "ambiguous");
assert.equal(strict[5].path, "Target.md");
assert.equal(strict[6].status, "missing");
console.log(JSON.stringify({ nodeOnly: true, policy: "desktop-compatibility", compatibility, strict }));
