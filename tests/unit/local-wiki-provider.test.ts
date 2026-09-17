import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nodeWikiWriteFileSystem,
  openLocalWikiProvider,
  type LocalWikiProvider,
  type WikiWriteFileSystem,
} from "../../src/wiki/folder-provider";
import type { WikiChangeEvent, WikiIndexSink, IndexedNote } from "../../src/wiki/contracts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "geode-provider-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, text, "utf8");
  }
  return root;
}

async function provider(
  files: Record<string, string> = {},
  options: Parameters<typeof openLocalWikiProvider>[1] = {},
): Promise<{ root: string; provider: LocalWikiProvider }> {
  const root = await fixture(files);
  const opened = await openLocalWikiProvider(root, options);
  if (opened.status !== "ok") throw new Error(`fixture provider failed to open: ${opened.error.code}`);
  return { root, provider: opened.provider };
}

/** Collects what the engine told an index and an event sink, in order. */
function sinks() {
  const events: WikiChangeEvent[] = [];
  const indexed = new Map<string, IndexedNote>();
  const removed: string[] = [];
  const index: WikiIndexSink = {
    upsert: (path, note) => { indexed.set(path, note); },
    remove: (path) => { indexed.delete(path); removed.push(path); },
  };
  return { events, indexed, removed, index, eventSink: { emit: (e: WikiChangeEvent) => { events.push(e); } } };
}

describe("local wiki provider: create, read, update, delete", () => {
  it("creates a note, puts it on disk, and makes it visible to the view", async () => {
    const { root, provider: p } = await provider({ "Target.md": "# Target\n" });

    expect(await p.create("New.md", "# New\n\nLinks to [[Target]].\n")).toEqual({ status: "ok", path: "New.md" });

    expect(await readFile(join(root, "New.md"), "utf8")).toBe("# New\n\nLinks to [[Target]].\n");
    expect(p.snapshot().listFiles().map((f) => f.path).sort()).toEqual(["New.md", "Target.md"]);
  });

  it("makes a created note's metadata, search hits and backlinks observable immediately", async () => {
    const { provider: p } = await provider({ "Target.md": "# Target\n" });

    expect(p.snapshot().backlinks("Target.md").references).toHaveLength(0);

    await p.create("Referrer.md", "---\ntag: alpha\n---\n\nSee [[Target]] for the distinctiveword.\n");
    const after = p.snapshot();

    const read = after.readNote("Referrer.md");
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(read.note.metadata.frontmatter).toEqual({ tag: "alpha" });

    expect(after.search("distinctiveword").hits.map((hit) => hit.path)).toEqual(["Referrer.md"]);
    expect(after.backlinks("Target.md").references.map((ref) => ref.sourcePath)).toEqual(["Referrer.md"]);
  });

  it("updates a note and the backlink it used to create disappears", async () => {
    const { root, provider: p } = await provider({
      "Target.md": "# Target\n",
      "Other.md": "# Other\n",
      "Referrer.md": "See [[Target]].\n",
    });
    expect(p.snapshot().backlinks("Target.md").references).toHaveLength(1);

    expect(await p.update("Referrer.md", "See [[Other]] instead.\n")).toEqual({ status: "ok", path: "Referrer.md" });

    expect(await readFile(join(root, "Referrer.md"), "utf8")).toBe("See [[Other]] instead.\n");
    expect(p.snapshot().backlinks("Target.md").references).toHaveLength(0);
    expect(p.snapshot().backlinks("Other.md").references.map((r) => r.sourcePath)).toEqual(["Referrer.md"]);
  });

  it("deletes a note from disk and from every query surface", async () => {
    const { root, provider: p } = await provider({
      "Target.md": "# Target\n",
      "Referrer.md": "See [[Target]] and findme.\n",
    });

    expect(await p.delete("Referrer.md")).toEqual({ status: "ok", path: "Referrer.md" });

    await expect(readFile(join(root, "Referrer.md"), "utf8")).rejects.toThrow();
    expect(p.snapshot().listFiles().map((f) => f.path)).toEqual(["Target.md"]);
    expect(p.snapshot().search("findme").hits).toEqual([]);
    expect(p.snapshot().backlinks("Target.md").references).toHaveLength(0);
    expect(p.snapshot().readNote("Referrer.md").status).toBe("absent");
  });

  it("creates intermediate directories for a nested note", async () => {
    const { root, provider: p } = await provider();

    expect(await p.create("a/b/Deep.md", "# Deep\n")).toEqual({ status: "ok", path: "a/b/Deep.md" });

    expect(await readFile(join(root, "a/b/Deep.md"), "utf8")).toBe("# Deep\n");
    expect(p.snapshot().readNote("a/b/Deep.md").status).toBe("ok");
  });

  it("survives a full create/update/delete round trip back to the original state", async () => {
    const { provider: p } = await provider({ "Keep.md": "# Keep\n" });
    const before = p.snapshot().listFiles().map((f) => f.path);

    await p.create("Temp.md", "one");
    await p.update("Temp.md", "two");
    await p.delete("Temp.md");

    expect(p.snapshot().listFiles().map((f) => f.path)).toEqual(before);
  });

  it("re-reads the folder on refresh, picking up an out-of-band change", async () => {
    const { root, provider: p } = await provider({ "Note.md": "original\n" });
    await writeFile(join(root, "Note.md"), "changed out of band\n", "utf8");

    // The detached view still shows what it captured...
    const stale = p.snapshot().readNote("Note.md");
    expect(stale.status === "ok" && stale.note.text).toBe("original\n");

    expect(await p.refresh()).toEqual({ status: "ok" });
    const fresh = p.snapshot().readNote("Note.md");
    expect(fresh.status === "ok" && fresh.note.text).toBe("changed out of band\n");
  });

  it("keeps each snapshot frozen and detached across writes", async () => {
    const { provider: p } = await provider({ "Note.md": "a" });
    const first = p.snapshot();
    await p.create("Second.md", "b");

    expect(first.listFiles()).toHaveLength(1);
    expect(p.snapshot().listFiles()).toHaveLength(2);
    expect(() => { (first.listFiles()[0] as { path: string }).path = "changed"; }).toThrow();
  });
});

describe("local wiki provider: refusals", () => {
  it.each([
    ["/Absolute.md", "absolute"],
    ["C:/Drive.md", "drive-absolute"],
    ["C:Drive.md", "drive-relative"],
    ["../Escape.md", "parent traversal"],
    ["a/../../Escape.md", "interior traversal escaping root"],
    ["a\\b.md", "backslash"],
    ["x\0y.md", "NUL"],
    ["./Dot.md", "unnormalized dot segment"],
    ["a//b.md", "empty segment"],
  ])("refuses to create %s (%s) and writes nothing", async (path) => {
    const { root, provider: p } = await provider();

    expect(await p.create(path, "payload")).toEqual({ status: "invalid-path" });
    expect(p.snapshot().listFiles()).toEqual([]);
    // Nothing escaped into the fixture root either.
    const opened = await openLocalWikiProvider(root);
    expect(opened.status === "ok" && opened.provider.snapshot().listFiles()).toEqual([]);
  });

  it.each(["/Absolute.md", "../Escape.md", "a\\b.md", "x\0y.md"])(
    "refuses to update or delete %s the same way",
    async (path) => {
      const { provider: p } = await provider({ "Note.md": "a" });
      expect(await p.update(path, "payload")).toEqual({ status: "invalid-path" });
      expect(await p.delete(path)).toEqual({ status: "invalid-path" });
    },
  );

  it("refuses to write a non-note, so attachments cannot be authored through this path", async () => {
    const { provider: p } = await provider();
    expect(await p.create("asset.png", "binary-ish")).toEqual({ status: "not-a-note" });
  });

  it("refuses to create over an existing note", async () => {
    const { root, provider: p } = await provider({ "Note.md": "original\n" });
    expect(await p.create("Note.md", "overwrite")).toEqual({ status: "already-exists", path: "Note.md" });
    expect(await readFile(join(root, "Note.md"), "utf8")).toBe("original\n");
  });

  it("refuses to update or delete a note that is not there", async () => {
    const { provider: p } = await provider();
    expect(await p.update("Missing.md", "x")).toEqual({ status: "absent", path: "Missing.md" });
    expect(await p.delete("Missing.md")).toEqual({ status: "absent", path: "Missing.md" });
  });

  it("refuses a note that exceeds the per-note byte limit", async () => {
    const { provider: p } = await provider({}, { limits: { maxNoteBytes: 16 } });
    expect(await p.create("Big.md", "x".repeat(17))).toEqual({ status: "note-byte-limit", path: "Big.md" });
    expect(await p.create("Ok.md", "x".repeat(16))).toEqual({ status: "ok", path: "Ok.md" });
  });

  it("counts an update against the total byte budget without double-counting the note it replaces", async () => {
    const { provider: p } = await provider({ "Note.md": "x".repeat(40) }, { limits: { maxTotalNoteBytes: 50 } });
    // Replacing 40 bytes with 50 fits; the old 40 must not be counted too.
    expect(await p.update("Note.md", "y".repeat(50))).toEqual({ status: "ok", path: "Note.md" });
    expect(await p.update("Note.md", "y".repeat(51))).toEqual({ status: "note-byte-limit", path: "Note.md" });
  });
});

describe("local wiki provider: portability collisions", () => {
  it("refuses to create a note whose identity collides with an existing one", async () => {
    // "é" composed vs "e" + combining acute: one file on macOS, two on Linux.
    const { provider: p } = await provider({ "Caf\u00e9.md": "composed\n" });

    expect(await p.create("Cafe\u0301.md", "decomposed\n")).toEqual({
      status: "portability-collision",
      path: "Cafe\u0301.md",
    });
    expect(p.snapshot().listFiles()).toHaveLength(1);
  });

  it("refuses a case-only collision for the same reason", async () => {
    const { provider: p } = await provider({ "Note.md": "a\n" });
    expect(await p.create("NOTE.md", "b\n")).toEqual({ status: "portability-collision", path: "NOTE.md" });
  });

  it("allows an update to a note whose own identity is unchanged", async () => {
    const { provider: p } = await provider({ "Caf\u00e9.md": "composed\n" });
    expect(await p.update("Caf\u00e9.md", "still composed\n")).toEqual({ status: "ok", path: "Caf\u00e9.md" });
  });

  it("allows creating the same identity again once the original is deleted", async () => {
    const { provider: p } = await provider({ "Note.md": "a\n" });
    await p.delete("Note.md");
    expect(await p.create("NOTE.md", "b\n")).toEqual({ status: "ok", path: "NOTE.md" });
  });
});

describe("local wiki provider: symlink and containment defence", () => {
  it("refuses to write through a symlink planted at the target path", async () => {
    const root = await fixture();
    roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), "geode-outside-"));
    roots.push(outside);
    const victim = join(outside, "victim.md");
    await writeFile(victim, "untouched\n", "utf8");
    await symlink(victim, join(root, "Link.md"));

    const opened = await openLocalWikiProvider(root);
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;

    // The symlink was excluded from the capture, so create sees a free path and
    // tries O_EXCL|O_NOFOLLOW — which the kernel refuses.
    const result = await opened.provider.create("Link.md", "payload");
    expect(result.status).not.toBe("ok");
    expect(await readFile(victim, "utf8")).toBe("untouched\n");
  });

  it("refuses to write into a directory that became a symlink out of the root", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "geode-outside-"));
    roots.push(outside);
    await symlink(outside, join(root, "escape"));

    const opened = await openLocalWikiProvider(root);
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;

    expect(await opened.provider.create("escape/Planted.md", "payload")).toEqual({
      status: "path-changed",
      path: "escape/Planted.md",
    });
    await expect(readFile(join(outside, "Planted.md"), "utf8")).rejects.toThrow();
  });

  it("refuses to write when an ancestor directory is swapped for a symlink mid-operation", async () => {
    const root = await fixture({ "folder/Note.md": "a\n" });
    const outside = await mkdtemp(join(tmpdir(), "geode-outside-"));
    roots.push(outside);

    let swapped = false;
    const racing: WikiWriteFileSystem = {
      ...nodeWikiWriteFileSystem,
      // Swap "folder" for a symlink the first time the provider re-verifies it.
      async lstat(path) {
        const stat = await nodeWikiWriteFileSystem.lstat(path);
        if (!swapped && path.endsWith("folder")) {
          swapped = true;
          await rm(join(root, "folder"), { recursive: true, force: true });
          await symlink(outside, join(root, "folder"));
        }
        return stat;
      },
    };

    const opened = await openLocalWikiProvider(root, { filesystem: racing });
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;

    const result = await opened.provider.update("folder/Note.md", "payload");
    expect(result.status).not.toBe("ok");
    await expect(readFile(join(outside, "Note.md"), "utf8")).rejects.toThrow();
  });

  it("reports path-changed rather than silently creating when the parent vanishes before the write", async () => {
    const root = await fixture({ "folder/Note.md": "a\n" });

    const racing: WikiWriteFileSystem = {
      ...nodeWikiWriteFileSystem,
      async realpath(path) {
        const resolved = await nodeWikiWriteFileSystem.realpath(path);
        // Report the parent as resolving somewhere else entirely.
        return path.endsWith("folder") ? join(resolved, "elsewhere") : resolved;
      },
    };

    const opened = await openLocalWikiProvider(root, { filesystem: racing });
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;

    expect((await opened.provider.update("folder/Note.md", "payload")).status).toBe("path-changed");
  });
});

describe("local wiki provider: concurrent mutation", () => {
  it("does not resurrect a note deleted from under an in-flight update", async () => {
    const root = await fixture({ "Note.md": "original\n" });

    const racing: WikiWriteFileSystem = {
      ...nodeWikiWriteFileSystem,
      async replaceFile(path, text) {
        await rm(join(root, "Note.md"), { force: true });
        return nodeWikiWriteFileSystem.replaceFile(path, text);
      },
    };

    const opened = await openLocalWikiProvider(root, { filesystem: racing });
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;

    // O_WRONLY|O_TRUNC without O_CREAT: the note stays deleted.
    expect(await opened.provider.update("Note.md", "payload")).toEqual({ status: "absent", path: "Note.md" });
    await expect(readFile(join(root, "Note.md"), "utf8")).rejects.toThrow();
  });

  it("converges the view when a delete finds the note already gone", async () => {
    const root = await fixture({ "Note.md": "a\n" });
    const opened = await openLocalWikiProvider(root);
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;

    await rm(join(root, "Note.md"), { force: true });

    expect(await opened.provider.delete("Note.md")).toEqual({ status: "absent", path: "Note.md" });
    // Reported honestly as absent, and the stale entry is dropped rather than lingering.
    expect(opened.provider.snapshot().listFiles()).toEqual([]);
  });

  it("reports the create that loses an exclusive-creation race", async () => {
    const root = await fixture();

    const racing: WikiWriteFileSystem = {
      ...nodeWikiWriteFileSystem,
      async createFile(path, text) {
        await writeFile(path, "winner\n", "utf8");
        return nodeWikiWriteFileSystem.createFile(path, text);
      },
    };

    const opened = await openLocalWikiProvider(root, { filesystem: racing });
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;

    expect(await opened.provider.create("Note.md", "loser\n")).toEqual({ status: "already-exists", path: "Note.md" });
    expect(await readFile(join(root, "Note.md"), "utf8")).toBe("winner\n");
    // The losing create must not have been recorded in the view.
    expect(opened.provider.snapshot().listFiles()).toEqual([]);
  });
});

describe("local wiki provider: regressions found in review", () => {
  it("refuses to refresh onto a different root rather than reading one vault and writing to another", async () => {
    // A symlinked root that gets retargeted. Before the fix, refresh() adopted
    // the new capture but kept writing to the root captured at open, so an
    // update reported ok, changed vault A, and left the viewed vault B alone.
    const vaultA = await fixture({ "Note.md": "A content\n" });
    const vaultB = await fixture({ "Note.md": "B content\n" });
    const parent = await mkdtemp(join(tmpdir(), "geode-rootswap-"));
    roots.push(parent);
    const link = join(parent, "current");
    await symlink(vaultA, link);

    const opened = await openLocalWikiProvider(link);
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;

    await rm(link, { force: true });
    await symlink(vaultB, link);

    expect(await opened.provider.refresh()).toEqual({ status: "error", error: { code: "root-changed" } });

    // The view is still the vault it was opened against, and so is any write.
    const stale = opened.provider.snapshot().readNote("Note.md");
    expect(stale.status === "ok" && stale.note.text).toBe("A content\n");
    expect(await opened.provider.update("Note.md", "written\n")).toEqual({ status: "ok", path: "Note.md" });
    expect(await readFile(join(vaultA, "Note.md"), "utf8")).toBe("written\n");
    expect(await readFile(join(vaultB, "Note.md"), "utf8")).toBe("B content\n");
  });

  it("refuses to write when the root is replaced by a different directory at the same path", async () => {
    // Name equality is not identity: before the fix, deleting and recreating
    // the root defeated every containment check.
    const root = await fixture({ "Note.md": "original\n" });
    const opened = await openLocalWikiProvider(root);
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;

    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "Note.md"), "a stranger's note\n", "utf8");

    expect(await opened.provider.update("Note.md", "clobbered\n")).toEqual({ status: "path-changed", path: "Note.md" });
    expect(await readFile(join(root, "Note.md"), "utf8")).toBe("a stranger's note\n");
  });

  it("refuses to update through a symlink planted where a note used to be", async () => {
    const root = await fixture({ "Note.md": "original\n" });
    const outside = await mkdtemp(join(tmpdir(), "geode-outside-"));
    roots.push(outside);
    const victim = join(outside, "victim.md");
    await writeFile(victim, "untouched\n", "utf8");

    const opened = await openLocalWikiProvider(root);
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;

    await rm(join(root, "Note.md"), { force: true });
    await symlink(victim, join(root, "Note.md"));

    expect(await opened.provider.update("Note.md", "payload\n")).toEqual({ status: "path-changed", path: "Note.md" });
    expect(await readFile(victim, "utf8")).toBe("untouched\n");
  });

  it.each([
    [".hidden.md", "dot-prefixed note"],
    [".secret/Note.md", "dot-prefixed folder"],
    ["node_modules/Note.md", "node_modules"],
    ["a/.git/Note.md", "dot-prefixed interior segment"],
  ])("refuses to create %s (%s), which the capture walk would never read back", async (path) => {
    // Writing these succeeded before the fix, so they appeared in the view
    // until the next refresh and then became permanently unreachable — delete
    // said absent, create said already-exists, and the bytes sat in the vault.
    const { root, provider: p } = await provider();

    expect(await p.create(path, "payload")).toEqual({ status: "invalid-path" });
    expect(p.snapshot().listFiles()).toEqual([]);
    await expect(readFile(join(root, path), "utf8")).rejects.toThrow();
  });

  it("agrees with the snapshot's own exclusion policy about what is writable", async () => {
    const { provider: p } = await provider({ "Note.md": "a\n" });
    const policy = p.snapshot().info.exclusionPolicy;
    // Guard against the policy being renamed or dropped without this being noticed.
    expect(policy).toBeDefined();
    for (const excluded of [".hidden.md", "node_modules/Note.md"]) {
      expect((await p.create(excluded, "x")).status).toBe("invalid-path");
    }
  });

  it("leaves the note intact and the view honest when a replace fails partway", async () => {
    // O_TRUNC-then-write would have emptied the note before failing, leaving
    // the view asserting content no longer on disk. The temp-file + rename
    // implementation means a failed write cannot publish a partial note.
    const root = await fixture({ "Note.md": "original content\n" });

    const failing: WikiWriteFileSystem = {
      ...nodeWikiWriteFileSystem,
      async replaceFile() { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
    };

    const opened = await openLocalWikiProvider(root, { filesystem: failing });
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;

    expect(await opened.provider.update("Note.md", "new content\n")).toEqual({ status: "write-failed", path: "Note.md" });
    expect(await readFile(join(root, "Note.md"), "utf8")).toBe("original content\n");
    const view = opened.provider.snapshot().readNote("Note.md");
    expect(view.status === "ok" && view.note.text).toBe("original content\n");
  });

  it("reports entry exhaustion as entry-limit, not as a byte limit", async () => {
    // A 2-byte note being refused with "note-byte-limit" told the caller to
    // shrink something that was never too big.
    const { provider: p } = await provider({ "One.md": "a\n" }, { limits: { maxEntries: 1 } });
    expect(await p.create("Two.md", "b\n")).toEqual({ status: "entry-limit", path: "Two.md" });
  });

  it("refuses every write when discovery was incomplete rather than answering from a partial view", async () => {
    // With a visited-entry cap the walk stops early, so "absent" would be a
    // guess: the note may exist and simply never have been seen.
    const { provider: p } = await provider(
      { "One.md": "a\n", "Two.md": "b\n", "Three.md": "c\n" },
      { limits: { maxVisitedEntries: 1 } },
    );
    expect(p.snapshot().info.discoveryComplete).toBe(false);

    expect((await p.create("New.md", "x")).status).toBe("capture-incomplete");
    expect((await p.update("One.md", "x")).status).toBe("capture-incomplete");
    expect((await p.delete("One.md")).status).toBe("capture-incomplete");
  });

  it("leaves no temp file behind after a successful replace", async () => {
    const { root, provider: p } = await provider({ "Note.md": "a\n" });
    await p.update("Note.md", "b\n");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
    expect(await readFile(join(root, "Note.md"), "utf8")).toBe("b\n");
  });
});

describe("local wiki provider: injected index and event contracts", () => {
  it("reports each applied write to the index and the event sink, in order", async () => {
    const { index, eventSink, events, indexed, removed } = sinks();
    const { provider: p } = await provider({ "Target.md": "# Target\n" }, { index, events: eventSink });

    await p.create("New.md", "See [[Target]].\n");
    await p.update("New.md", "See [[Target]] twice [[Target]].\n");
    await p.delete("New.md");

    expect(events).toEqual([
      { type: "created", path: "New.md" },
      { type: "updated", path: "New.md" },
      { type: "deleted", path: "New.md" },
    ]);
    expect(removed).toEqual(["New.md"]);
    expect(indexed.has("New.md")).toBe(false);
  });

  it("hands the index parsed metadata, not just raw text", async () => {
    const { index, indexed } = sinks();
    const { provider: p } = await provider({}, { index });

    await p.create("Note.md", "---\ntitle: Parsed\n---\n\n# Heading\n\n[[Link]]\n");

    const note = indexed.get("Note.md");
    expect(note?.metadata.frontmatter).toEqual({ title: "Parsed" });
    expect(note?.metadata.headings.map((h) => h.heading)).toEqual(["Heading"]);
    expect(note?.metadata.links.map((l) => l.link)).toEqual(["Link"]);
  });

  it("reports nothing for a refused write", async () => {
    const { index, eventSink, events, indexed } = sinks();
    const { provider: p } = await provider({ "Note.md": "a\n" }, { index, events: eventSink });

    await p.create("Note.md", "overwrite");
    await p.create("../Escape.md", "payload");
    await p.update("Missing.md", "x");

    expect(events).toEqual([]);
    expect(indexed.size).toBe(0);
  });

  it("does not let a throwing subscriber undo a write that already happened", async () => {
    const { root, provider: p } = await provider({}, {
      events: { emit: () => { throw new Error("subscriber exploded"); } },
    });

    expect(await p.create("Note.md", "content\n")).toEqual({ status: "ok", path: "Note.md" });
    expect(await readFile(join(root, "Note.md"), "utf8")).toBe("content\n");
    expect(p.snapshot().readNote("Note.md").status).toBe("ok");
  });

  it("emits only after the view is rebuilt, so a subscriber sees the change it was told about", async () => {
    let observed: string[] = [];
    const root = await fixture();
    const opened = await openLocalWikiProvider(root, {
      events: { emit: () => { observed = holder.provider.snapshot().listFiles().map((f) => f.path); } },
    });
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;
    const holder = opened;

    await holder.provider.create("Note.md", "a\n");
    expect(observed).toEqual(["Note.md"]);
  });
});

describe("local wiki provider: contract narrowness", () => {
  it("accepts sinks that are nothing more than their own methods", async () => {
    // If WikiIndexSink or WikiEventSink had grown host vocabulary, these
    // object literals would not satisfy them.
    const calls: string[] = [];
    const { provider: p } = await provider({}, {
      index: { upsert: (path) => { calls.push(`upsert:${path}`); }, remove: (path) => { calls.push(`remove:${path}`); } },
      events: { emit: (event) => { calls.push(`${event.type}:${event.path}`); } },
    });

    await p.create("Note.md", "a\n");
    await p.delete("Note.md");

    expect(calls).toEqual(["upsert:Note.md", "created:Note.md", "remove:Note.md", "deleted:Note.md"]);
  });

  it("works with no sinks injected at all", async () => {
    const { provider: p } = await provider();
    expect(await p.create("Note.md", "a\n")).toEqual({ status: "ok", path: "Note.md" });
  });
});
