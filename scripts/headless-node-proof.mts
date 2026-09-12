import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMetadata } from "../src/wiki/metadata";
import type { CachedMetadata } from "../src/wiki/types";
import { resolveFirstLinkpathDest, type LinkResolutionProvider } from "../src/wiki/link-resolution";

// A deliberately small fixture provider, not a production filesystem adapter.
// Paths are fixed synthetic fixtures. General path validation belongs to Phase 1.
assert.equal("window" in globalThis, false);
assert.equal("document" in globalThis, false);
assert.equal(process.versions.electron, undefined);
const directory = await mkdtemp(join(tmpdir(), "geode-headless-node-"));
try {
  const notes = {
    "Source.md": "---\ntags: [research]\n---\n# Source\n[[Decision#Choice]] ![[asset.png]]",
    "Decision.md": "---\naliases: [Choice]\n---\n# Choice\n[[Source]]",
  };
  for (const [path, content] of Object.entries(notes)) await writeFile(join(directory, path), content);
  await writeFile(join(directory, "asset.png"), new Uint8Array([0, 1, 2]));
  const entries = new Map<string, { path: string }>();
  const byBasename = new Map<string, string[]>();
  const byAlias = new Map<string, string[]>();
  for (const path of [...Object.keys(notes), "asset.png"].sort()) {
    entries.set(path, { path });
    byBasename.set(path.toLowerCase(), [path]);
    byBasename.set(path.replace(/\.[^.]+$/, "").toLowerCase(), [path]);
  }
  const metadata = new Map<string, CachedMetadata>();
  for (const path of Object.keys(notes)) {
    const parsed = parseMetadata(await readFile(join(directory, path), "utf8"));
    metadata.set(path, parsed);
    for (const alias of parsed.aliases) byAlias.set(alias.toLowerCase(), [path]);
  }
  const provider: LinkResolutionProvider<{ path: string }> = {
    getFileByPath: (path) => entries.get(path) ?? null,
    byBasename,
    byAlias,
  };
  const source = metadata.get("Source.md")!;
  assert.deepEqual(source.tags.map(({ tag }) => tag), ["research"]);
  assert.equal(resolveFirstLinkpathDest(source.links[0].link, "Source.md", provider)?.path, "Decision.md");
  assert.equal(resolveFirstLinkpathDest("Choice", "Source.md", provider)?.path, "Decision.md");
  assert.equal(resolveFirstLinkpathDest(source.embeds[0].link, "Source.md", provider)?.path, "asset.png");
  assert.equal(resolveFirstLinkpathDest("Missing", "Source.md", provider), null);
  console.log(JSON.stringify({ nodeOnly: true, notes: metadata.size, resolvedReferences: 3, missingTarget: null }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
