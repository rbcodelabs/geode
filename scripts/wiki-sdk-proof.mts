import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The point of this proof: *only* the curated entry point is imported. Nothing
// reaches past `src/wiki/index.ts` into the parser, the candidate pipeline, the
// filesystem seam or the snapshot constructor. If the SDK cannot do it, the
// proof cannot do it.
import * as sdk from "../src/wiki/index";

// Fresh Node, no host.
assert.ok(!("window" in globalThis), "window must not exist");
assert.ok(!("document" in globalThis), "document must not exist");
assert.equal(process.versions.electron, undefined, "must not run under Electron");

// The module's *runtime* exports, measured rather than assumed. A regex, a
// scan-cap resolver or the snapshot constructor leaking into the surface would
// change this list and fail here.
const runtimeExports = Object.keys(sdk).sort();
assert.deepEqual(
  runtimeExports,
  ["DEFAULT_WIKI_LIMITS", "openWikiSession"],
  "the SDK must export exactly one opener and one constant at runtime",
);

const root = await mkdtemp(join(tmpdir(), "geode-wiki-sdk-"));
try {
  // Two notes sharing a basename in different folders, so a bare `[[Dup]]`
  // has no single right answer and must be reported as ambiguous rather than
  // silently tie-broken.
  await mkdir(join(root, "a"));
  await mkdir(join(root, "b"));
  await writeFile(join(root, "Target.md"), "# Target\n\nThe target note.\n", "utf8");
  await writeFile(join(root, "a/Dup.md"), "# Dup A\n", "utf8");
  await writeFile(join(root, "b/Dup.md"), "# Dup B\n", "utf8");

  // 1. OPEN a folder, through the SDK alone.
  const opened = await sdk.openWikiSession(root);
  assert.equal(opened.status, "ok", "the session must open the folder");
  if (opened.status !== "ok") throw new Error("unreachable");
  const session = opened.session;

  // The narrowing is structural, not documentary: there is no way to obtain a
  // snapshot handle from this surface, which is what makes a stale read after
  // a write unrepresentable rather than merely discouraged.
  const surface = Object.keys(session).sort();
  assert.deepEqual(
    surface,
    [
      "backlinks", "createNote", "deleteNote", "info", "listFiles",
      "outgoingLinks", "readNote", "refresh", "resolveLink", "search", "updateNote",
    ],
    "the session surface must be exactly the documented eleven methods",
  );
  assert.ok(!("snapshot" in session), "the session must not hand out a snapshot handle");
  assert.ok(!("provider" in session), "the session must not hand out the provider");

  const info = session.info();
  assert.equal(info.discoveryComplete, true, "the seeded folder must be walked completely");
  assert.equal(info.referenceSyntax, "wikilinks", "the engine must declare its reference syntax");

  const listed = () => session.listFiles().map((file) => file.path);
  assert.deepEqual(listed(), ["Target.md", "a/Dup.md", "b/Dup.md"], "the seeded notes must be listed");
  // `listFiles` is the narrowed entry type: paths and kinds, never bodies.
  assert.deepEqual(
    Object.keys(session.listFiles()[0]).sort(), ["kind", "path"],
    "a listing entry must expose only path and kind",
  );

  // Measured sequences, so a session that stopped applying writes would change
  // these rather than still printing the same constants.
  const fileCounts: number[] = [session.listFiles().length];
  const backlinkCounts: number[] = [session.backlinks("Target.md").references.length];
  const searchCounts: number[] = [];
  assert.equal(backlinkCounts[0], 0, "nothing links to Target.md yet");

  // 2. CREATE a note — and read it back with no refresh and no re-open. This
  //    is the consistency pin: the write must be visible to the very next read.
  const body = "---\nstatus: draft\naliases: [Pointer]\n---\n\n# Referrer\n\n"
    + "Points at [[Target]], at [[Dup]], and mentions plesiosaur.\n";
  const created = await session.createNote("notes/Referrer.md", body);
  assert.deepEqual(created, { status: "ok", path: "notes/Referrer.md" }, "create must succeed");
  assert.equal(await readFile(join(root, "notes/Referrer.md"), "utf8"), body, "create must reach the real filesystem");

  // 3. READ a note with metadata, immediately.
  const read = session.readNote("notes/Referrer.md");
  assert.equal(read.status, "ok", "the just-created note must be readable without a refresh");
  if (read.status !== "ok") throw new Error("unreachable");
  assert.deepEqual(read.note.metadata?.frontmatter, { status: "draft", aliases: ["Pointer"] }, "frontmatter must be parsed");
  assert.deepEqual(read.note.metadata?.headings.map((h) => h.heading), ["Referrer"], "headings must be parsed");
  assert.deepEqual(read.note.metadata?.links.map((l) => l.link), ["Target", "Dup"], "wikilinks must be parsed");
  assert.deepEqual(read.note.metadata?.aliases, ["Pointer"], "aliases must be parsed");
  assert.equal(read.note.coverage.referencesCertain, true, "this fixture must parse with certain references");
  fileCounts.push(session.listFiles().length);

  // 4. SEARCH, immediately.
  assert.deepEqual(
    session.search("plesiosaur").hits.map((hit) => hit.path),
    ["notes/Referrer.md"],
    "search must find the just-created note",
  );
  assert.equal(session.search("plesiosaur").complete, true, "search must report itself complete here");
  searchCounts.push(session.search("plesiosaur").hits.length);

  // 5. RESOLVE links, including an ambiguous one and a missing one.
  const unique = session.resolveLink("notes/Referrer.md", "Target");
  assert.equal(unique.status, "resolved", "a unique basename must resolve");
  assert.equal(unique.path, "Target.md", "and to the right note");

  const ambiguous = session.resolveLink("notes/Referrer.md", "Dup");
  assert.equal(ambiguous.status, "ambiguous", "two notes sharing a basename must be ambiguous, not tie-broken");
  assert.deepEqual(ambiguous.candidates, ["a/Dup.md", "b/Dup.md"], "both candidates must be reported");
  assert.equal(ambiguous.path, undefined, "an ambiguous resolution must not pick a winner");

  const missing = session.resolveLink("notes/Referrer.md", "Nope");
  assert.equal(missing.status, "missing", "an unmatched target must be missing");
  const viaAlias = session.resolveLink("Target.md", "Pointer");
  assert.equal(viaAlias.status, "resolved", "an alias must resolve");
  assert.equal(viaAlias.path, "notes/Referrer.md", "and to the aliased note");

  const outgoing = session.outgoingLinks("notes/Referrer.md");
  assert.deepEqual(
    outgoing.references.map((ref) => [ref.link, ref.resolution.status]),
    [["Target", "resolved"], ["Dup", "ambiguous"]],
    "outgoing links must carry their own resolutions, ambiguity included",
  );

  // 6. BACKLINKS, immediately.
  assert.deepEqual(
    session.backlinks("Target.md").references.map((ref) => ref.sourcePath),
    ["notes/Referrer.md"],
    "the created note must produce a backlink",
  );
  backlinkCounts.push(session.backlinks("Target.md").references.length);

  // 7. UPDATE — the old content must stop matching and the new backlink appear,
  //    again with no refresh.
  const updated = await session.updateNote(
    "notes/Referrer.md",
    "# Referrer\n\nNow points at [[a/Dup]] and mentions ichthyosaur.\n",
  );
  assert.deepEqual(updated, { status: "ok", path: "notes/Referrer.md" }, "update must succeed");
  assert.equal(session.search("plesiosaur").hits.length, 0, "stale content must stop matching immediately");
  assert.equal(session.search("ichthyosaur").hits.length, 1, "new content must match immediately");
  assert.equal(session.backlinks("Target.md").references.length, 0, "the old backlink must be gone immediately");
  assert.deepEqual(
    session.backlinks("a/Dup.md").references.map((ref) => ref.sourcePath),
    ["notes/Referrer.md"],
    "the new backlink must be present immediately",
  );
  assert.equal(
    session.resolveLink("notes/Referrer.md", "a/Dup").status, "resolved",
    "an exact path must resolve even where its basename is ambiguous",
  );
  backlinkCounts.push(session.backlinks("Target.md").references.length);
  searchCounts.push(session.search("plesiosaur").hits.length);

  // 8. DELETE — gone from every read, immediately.
  const deleted = await session.deleteNote("notes/Referrer.md");
  assert.deepEqual(deleted, { status: "ok", path: "notes/Referrer.md" }, "delete must succeed");
  await assert.rejects(readFile(join(root, "notes/Referrer.md"), "utf8"), "delete must reach the real filesystem");
  assert.equal(session.readNote("notes/Referrer.md").status, "absent", "the note must be gone from reads immediately");
  assert.equal(session.search("ichthyosaur").hits.length, 0, "the note must be gone from search immediately");
  assert.equal(session.backlinks("a/Dup.md").references.length, 0, "the backlink must be gone immediately");
  fileCounts.push(session.listFiles().length);
  searchCounts.push(session.search("ichthyosaur").hits.length);

  // Refusals reach the same fresh process through the SDK, and change nothing.
  const refusals = {
    traversal: (await session.createNote("../Escape.md", "payload")).status,
    absolute: (await session.createNote("/Escape.md", "payload")).status,
    backslash: (await session.createNote("a\\b.md", "payload")).status,
    nul: (await session.createNote("x\0y.md", "payload")).status,
    dotSegment: (await session.createNote(".secret/Note.md", "payload")).status,
    notANote: (await session.createNote("asset.png", "payload")).status,
    duplicate: (await session.createNote("Target.md", "payload")).status,
    caseCollision: (await session.createNote("TARGET.md", "payload")).status,
    missingUpdate: (await session.updateNote("Nope.md", "payload")).status,
  };
  assert.deepEqual(refusals, {
    traversal: "invalid-path", absolute: "invalid-path", backslash: "invalid-path",
    nul: "invalid-path", dotSegment: "invalid-path", notANote: "not-a-note",
    duplicate: "already-exists", caseCollision: "portability-collision", missingUpdate: "absent",
  }, "every refusal must keep its own distinct status through the SDK");
  assert.equal(
    await readFile(join(root, "Target.md"), "utf8"), "# Target\n\nThe target note.\n",
    "refused writes must not touch existing notes",
  );

  // An edit made outside the session is invisible until `refresh()` — stated in
  // the session contract, so proven rather than assumed.
  await writeFile(join(root, "Outside.md"), "# Outside\n", "utf8");
  assert.equal(session.readNote("Outside.md").status, "absent", "an external write must not appear on its own");
  assert.equal((await session.refresh()).status, "ok", "refresh must succeed");
  assert.equal(session.readNote("Outside.md").status, "ok", "refresh must be the way an external write becomes visible");
  fileCounts.push(session.listFiles().length);

  console.log(JSON.stringify({
    nodeOnly: true,
    runtimeExports,
    sessionMethods: surface.length,
    snapshotHandleReachable: "snapshot" in session,
    // Target.md backlinks: none -> one (create) -> none (update retargets).
    backlinkCounts,
    // "plesiosaur" hits after create, then after update; then "ichthyosaur"
    // after delete.
    searchCounts,
    // 3 seeded -> 4 after create -> 3 after delete -> 4 after refresh picks up
    // the externally written note.
    fileCounts,
    resolutions: {
      unique: unique.status, ambiguous: ambiguous.status,
      ambiguousCandidates: ambiguous.candidates.length,
      missing: missing.status, alias: viaAlias.status,
    },
    refusals: Object.keys(refusals).length,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
