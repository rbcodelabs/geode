import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openLocalWikiSnapshot } from "../src/wiki/local-filesystem";

assert.equal("window" in globalThis, false);
assert.equal("document" in globalThis, false);
assert.equal(process.versions.electron, undefined);
const directory = await mkdtemp(join(tmpdir(), "geode-local-wiki-proof-"));
try {
  const files = {
    "folder/Source.md": "# Source\n[[Guide#Heading]] [[Target#Missing]] [[Target#^block]] [[Twin]] ![[asset.png]] [[#Source]] [[Nope]]",
    "Target.md": "---\naliases: [Guide, Guide]\n---\n# Heading\n- item ^block",
    "a/Twin.md": "first twin", "b/Twin.md": "second twin", "asset.png": "fixture identity only",
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  const result = await openLocalWikiSnapshot(directory);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw Error("Expected snapshot");
  const s = result.snapshot;
  assert.equal(s.listFiles().length, 5);
  const source = s.readNote("folder/Source.md");
  assert.equal(source.status, "ok");
  assert.equal(s.search("twin").hits.length, 3);
  assert.equal(s.resolve("folder/Source.md", "Guide#Heading").subpath.status, "found");
  assert.equal(s.resolve("folder/Source.md", "../Target#^block").subpath.status, "found");
  assert.equal(s.resolve("folder/Source.md", "./Twin").status, "missing");
  const ambiguous = s.resolve("folder/Source.md", "Twin");
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(s.outgoing("folder/Source.md").references.length, 7);
  const backlinks = s.backlinks("Target.md");
  assert.equal(backlinks.references.length, 3);
  assert.equal(backlinks.references[1].resolution.subpath.status, "missing");
  assert.equal(backlinks.coverage.completeMarkdownGraph, false);
  assert.throws(() => { s.listFiles()[0].path = "changed"; });
  await writeFile(join(directory, "Target.md"), "changed");
  await rm(join(directory, "folder/Source.md"));
  assert.equal(s.search("changed").hits.length, 0);
  assert.equal(s.readNote("folder/Source.md").status, "ok");
  await writeFile(join(directory, "Broken.md"), "---\naliases: [broken\n---\n# CRLF\r\n[markdown](Target.md)\n~~~\n[[Target]]\n~~~");
  const reopened = await openLocalWikiSnapshot(directory);
  assert.equal(reopened.status, "ok");
  if (reopened.status !== "ok") throw Error("Expected reopened snapshot");
  for (const code of ["frontmatter-malformed", "crlf-headings", "markdown-links-unsupported", "tilde-fence-references"]) {
    assert.ok(reopened.snapshot.info.diagnostics.some(d => d.code === code));
  }
  assert.equal(reopened.snapshot.resolve("Broken.md", "#CRLF").subpath.status, "unknown");
  console.log(JSON.stringify({ nodeOnly: true, files: 5, queryOperations: 7, duplicateCandidates: 2, snapshotDetached: true, diagnostics: true }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
