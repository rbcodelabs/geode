import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalWikiProvider } from "../src/wiki/folder-provider";
import { matchFileAgainstTerms, parseQuery } from "../src/wiki/search";
import type { WikiChangeEvent } from "../src/wiki/contracts";

// Fresh Node, no host: the whole point of the exercise.
assert.ok(!("window" in globalThis), "window must not exist");
assert.ok(!("document" in globalThis), "document must not exist");
assert.equal(process.versions.electron, undefined, "must not run under Electron");

const root = await mkdtemp(join(tmpdir(), "geode-local-wiki-write-"));
try {
  await writeFile(join(root, "Target.md"), "# Target\n\nThe target note.\n", "utf8");

  const events: WikiChangeEvent[] = [];
  const indexed = new Map<string, { text: string; headings: string[] }>();

  const opened = await openLocalWikiProvider(root, {
    index: {
      upsert: (path, note) => { indexed.set(path, { text: note.text, headings: note.metadata.headings.map(h => h.heading) }); },
      remove: (path) => { indexed.delete(path); },
    },
    events: { emit: (event) => { events.push(event); } },
  });
  assert.equal(opened.status, "ok", "provider must open the folder");
  if (opened.status !== "ok") throw new Error("unreachable");
  const provider = opened.provider;

  assert.equal(provider.snapshot().listFiles().length, 1, "starts with the one seeded note");
  assert.equal(provider.snapshot().backlinks("Target.md").references.length, 0, "no backlinks yet");

  // CREATE, then observe metadata, search and backlinks.
  const created = await provider.create(
    "notes/Referrer.md",
    "---\nstatus: draft\n---\n\n# Referrer\n\nPoints at [[Target]] and mentions plesiosaur.\n",
  );
  assert.deepEqual(created, { status: "ok", path: "notes/Referrer.md" }, "create must succeed");
  assert.equal(
    await readFile(join(root, "notes/Referrer.md"), "utf8"),
    "---\nstatus: draft\n---\n\n# Referrer\n\nPoints at [[Target]] and mentions plesiosaur.\n",
    "create must reach the real filesystem",
  );

  const afterCreate = provider.snapshot();
  const read = afterCreate.readNote("notes/Referrer.md");
  assert.equal(read.status, "ok", "the created note must be readable");
  assert.deepEqual(
    read.status === "ok" ? read.note.metadata?.frontmatter ?? null : null,
    { status: "draft" },
    "metadata must reflect the created note",
  );
  assert.deepEqual(
    afterCreate.search("plesiosaur").hits.map(hit => hit.path),
    ["notes/Referrer.md"],
    "search must find the created note",
  );
  assert.deepEqual(
    afterCreate.backlinks("Target.md").references.map(ref => ref.sourcePath),
    ["notes/Referrer.md"],
    "the created note must produce a backlink",
  );

  // UPDATE, then observe the backlink and search change.
  await writeFile(join(root, "Other.md"), "# Other\n", "utf8");
  assert.equal((await provider.refresh()).status, "ok", "refresh must pick up the sibling note");
  const updated = await provider.update("notes/Referrer.md", "# Referrer\n\nNow points at [[Other]] and mentions ichthyosaur.\n");
  assert.deepEqual(updated, { status: "ok", path: "notes/Referrer.md" }, "update must succeed");

  const afterUpdate = provider.snapshot();
  assert.equal(afterUpdate.backlinks("Target.md").references.length, 0, "the old backlink must be gone");
  assert.deepEqual(
    afterUpdate.backlinks("Other.md").references.map(ref => ref.sourcePath),
    ["notes/Referrer.md"],
    "the new backlink must be present",
  );
  assert.equal(afterUpdate.search("plesiosaur").hits.length, 0, "stale content must stop matching");
  assert.equal(afterUpdate.search("ichthyosaur").hits.length, 1, "new content must match");

  // The portable query primitives run here too, against the same note.
  const note = afterUpdate.readNote("notes/Referrer.md");
  const match = note.status === "ok"
    ? matchFileAgainstTerms({ name: "Referrer.md", path: "notes/Referrer.md" }, note.note.text, parseQuery("path:notes ichthyosaur"), () => [])
    : null;
  assert.ok(match, "the portable matcher must evaluate operators in fresh Node");
  assert.equal(match.snippets.length, 1, "the matcher must produce a snippet");

  // DELETE, then observe removal everywhere.
  const deleted = await provider.delete("notes/Referrer.md");
  assert.deepEqual(deleted, { status: "ok", path: "notes/Referrer.md" }, "delete must succeed");
  await assert.rejects(readFile(join(root, "notes/Referrer.md"), "utf8"), "delete must reach the real filesystem");

  const afterDelete = provider.snapshot();
  assert.equal(afterDelete.readNote("notes/Referrer.md").status, "absent", "the note must be gone from the view");
  assert.equal(afterDelete.search("ichthyosaur").hits.length, 0, "the note must be gone from search");
  assert.equal(afterDelete.backlinks("Other.md").references.length, 0, "the backlink must be gone");

  // Refusals reach the same fresh process, and change nothing.
  const refusals = {
    traversal: (await provider.create("../Escape.md", "payload")).status,
    absolute: (await provider.create("/Escape.md", "payload")).status,
    backslash: (await provider.create("a\\b.md", "payload")).status,
    nul: (await provider.create("x\0y.md", "payload")).status,
    notANote: (await provider.create("asset.png", "payload")).status,
    duplicate: (await provider.create("Target.md", "payload")).status,
    caseCollision: (await provider.create("TARGET.md", "payload")).status,
    missingUpdate: (await provider.update("Nope.md", "payload")).status,
  };
  assert.deepEqual(refusals, {
    traversal: "invalid-path", absolute: "invalid-path", backslash: "invalid-path", nul: "invalid-path",
    notANote: "not-a-note", duplicate: "already-exists", caseCollision: "portability-collision",
    missingUpdate: "absent",
  }, "every refusal must be reported by its own distinct status");

  assert.equal(await readFile(join(root, "Target.md"), "utf8"), "# Target\n\nThe target note.\n", "refused writes must not touch existing notes");

  // The injected contracts saw exactly the applied writes, in order.
  assert.deepEqual(events, [
    { type: "created", path: "notes/Referrer.md" },
    { type: "updated", path: "notes/Referrer.md" },
    { type: "deleted", path: "notes/Referrer.md" },
  ], "the event sink must see applied writes only");
  assert.equal(indexed.has("notes/Referrer.md"), false, "the index must have dropped the deleted note");

  console.log(JSON.stringify({
    nodeOnly: true,
    created: 1,
    updated: 1,
    deleted: 1,
    refusals: Object.keys(refusals).length,
    events: events.length,
    backlinksObserved: true,
    searchObserved: true,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
