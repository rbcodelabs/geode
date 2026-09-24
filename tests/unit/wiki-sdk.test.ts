import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as sdk from "../../src/wiki/index";
import { DEFAULT_WIKI_LIMITS, openWikiSession, type WikiSession } from "../../src/wiki/index";
import { DEFAULT_SNAPSHOT_LIMITS } from "../../src/wiki/snapshot";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "geode-wiki-sdk-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, text, "utf8");
  }
  return root;
}

async function session(
  files: Record<string, string> = {},
  options: Parameters<typeof openWikiSession>[1] = {},
): Promise<{ root: string; session: WikiSession }> {
  const root = await fixture(files);
  const opened = await openWikiSession(root, options);
  if (opened.status !== "ok") throw new Error(`fixture session failed to open: ${opened.error.code}`);
  return { root, session: opened.session };
}

describe("the SDK's public surface", () => {
  it("exports exactly one opener and one constant at runtime", () => {
    // Types are erased, so this is the whole runtime surface. Anything that
    // leaks a parser regex, the scan-cap resolver, `createWikiSnapshot`, the
    // filesystem seam or the desktop resolver would show up here.
    expect(Object.keys(sdk).sort()).toEqual(["DEFAULT_WIKI_LIMITS", "openWikiSession"]);
  });

  it("re-exports the capture limits under the surface's own name, unchanged in value", () => {
    expect(DEFAULT_WIKI_LIMITS).toEqual(DEFAULT_SNAPSHOT_LIMITS);
  });

  it("hands out a session with exactly eleven methods and no view handle", async () => {
    const { session: s } = await session({ "A.md": "# A\n" });
    expect(Object.keys(s).sort()).toEqual([
      "backlinks", "createNote", "deleteNote", "info", "listFiles",
      "outgoingLinks", "readNote", "refresh", "resolveLink", "search", "updateNote",
    ]);
    // The decision in ADR 0023, expressed as a test: there is no way to obtain
    // the underlying snapshot or provider, because holding either across a
    // write is the stale-read hazard the session exists to remove.
    expect("snapshot" in s).toBe(false);
    expect("provider" in s).toBe(false);
  });

  it("lists files as paths and kinds only, never bodies", async () => {
    const { session: s } = await session({ "A.md": "# A\n", "img.png": "bytes" });
    expect(s.listFiles()).toEqual([
      { path: "A.md", kind: "note" },
      { path: "img.png", kind: "attachment" },
    ]);
  });

  it("forwards only `limits` to the provider, never an injected adapter seam", async () => {
    const root = await fixture({ "A.md": "# A\n" });
    // `openLocalWikiProvider` accepts `filesystem`, `index` and `events`. None
    // is part of this surface. If the SDK spread its options object through,
    // this filesystem would be used and the open would fail; instead the extra
    // keys are dropped and the real Node filesystem is used.
    const hostile = {
      limits: { maxDepth: 4 },
      filesystem: new Proxy({}, { get: () => () => { throw new Error("adapter seam reached"); } }),
      index: { upsert: () => { throw new Error("index sink reached"); }, remove: () => {} },
      events: { emit: () => { throw new Error("event sink reached"); } },
    };
    const opened = await openWikiSession(root, hostile as Parameters<typeof openWikiSession>[1]);
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;
    expect(opened.session.info().limits.maxDepth).toBe(4);
    // The event sink would have thrown here had it been forwarded.
    expect((await opened.session.createNote("B.md", "# B\n")).status).toBe("ok");
  });

  it("reports a capture failure rather than throwing", async () => {
    const opened = await openWikiSession(join(tmpdir(), "geode-wiki-sdk-does-not-exist-9e3f"));
    expect(opened.status).toBe("error");
    if (opened.status !== "error") return;
    expect(opened.error.code).toBe("root-unavailable");
  });
});

describe("session read-after-write consistency", () => {
  // This is the pinned decision. Each assertion runs with no `refresh()` and no
  // re-open between the write and the read.

  it("makes a created note visible to the very next read", async () => {
    const { session: s } = await session({ "Target.md": "# Target\n" });
    expect(s.readNote("N.md").status).toBe("absent");

    expect((await s.createNote("N.md", "---\nk: v\n---\n\n# N\n\n[[Target]] pterosaur\n")).status).toBe("ok");

    const read = s.readNote("N.md");
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.note.metadata?.frontmatter).toEqual({ k: "v" });
    expect(s.listFiles().map((f) => f.path)).toEqual(["N.md", "Target.md"]);
    expect(s.search("pterosaur").hits.map((h) => h.path)).toEqual(["N.md"]);
    expect(s.backlinks("Target.md").references.map((r) => r.sourcePath)).toEqual(["N.md"]);
    expect(s.outgoingLinks("N.md").references.map((r) => r.link)).toEqual(["Target"]);
    expect(s.resolveLink("N.md", "Target").path).toBe("Target.md");
  });

  it("makes an update visible to the very next read, in both directions", async () => {
    const { session: s } = await session({
      "Target.md": "# Target\n",
      "Other.md": "# Other\n",
      "N.md": "# N\n\n[[Target]] pterosaur\n",
    });
    expect((await s.updateNote("N.md", "# N\n\n[[Other]] ammonite\n")).status).toBe("ok");

    expect(s.search("pterosaur").hits).toHaveLength(0);
    expect(s.search("ammonite").hits).toHaveLength(1);
    expect(s.backlinks("Target.md").references).toHaveLength(0);
    expect(s.backlinks("Other.md").references.map((r) => r.sourcePath)).toEqual(["N.md"]);
  });

  it("makes a delete visible to the very next read", async () => {
    const { session: s } = await session({
      "Target.md": "# Target\n",
      "N.md": "# N\n\n[[Target]] pterosaur\n",
    });
    expect((await s.deleteNote("N.md")).status).toBe("ok");

    expect(s.readNote("N.md").status).toBe("absent");
    expect(s.listFiles().map((f) => f.path)).toEqual(["Target.md"]);
    expect(s.search("pterosaur").hits).toHaveLength(0);
    expect(s.backlinks("Target.md").references).toHaveLength(0);
  });

  it("leaves a previously returned result frozen and detached, which is why no handle is handed out", async () => {
    const { session: s } = await session({ "Target.md": "# Target\n" });
    const before = s.backlinks("Target.md");
    expect(before.references).toHaveLength(0);

    await s.createNote("N.md", "# N\n\n[[Target]]\n");

    // The value read earlier still describes the world as it was — it is a
    // detached, frozen result, not a live view. That is correct and expected.
    // The hazard is a caller *mistaking* such a value for the current state,
    // which is exactly what handing out a reusable snapshot handle would
    // encourage. A fresh call is the current state.
    expect(before.references).toHaveLength(0);
    expect(Object.isFrozen(before)).toBe(true);
    expect(s.backlinks("Target.md").references.map((r) => r.sourcePath)).toEqual(["N.md"]);
  });

  it("does not observe an edit made outside the session until refresh", async () => {
    const { root, session: s } = await session({ "A.md": "# A\n" });
    await writeFile(join(root, "B.md"), "# B\n", "utf8");

    expect(s.readNote("B.md").status).toBe("absent");
    expect((await s.refresh()).status).toBe("ok");
    expect(s.readNote("B.md").status).toBe("ok");
  });
});

describe("link resolution through the SDK", () => {
  it("reports ambiguity rather than silently tie-breaking it", async () => {
    // The desktop-compatibility resolver would pick one of these by length and
    // then lexical order. The SDK answers under agent-strict policy, which
    // says it cannot tell.
    const { session: s } = await session({
      "a/Dup.md": "# A\n",
      "b/Dup.md": "# B\n",
      "N.md": "# N\n\n[[Dup]]\n",
    });
    const resolution = s.resolveLink("N.md", "Dup");
    expect(resolution.status).toBe("ambiguous");
    expect(resolution.candidates).toEqual(["a/Dup.md", "b/Dup.md"]);
    expect(resolution.path).toBeUndefined();

    // And the ambiguity travels with the reference in the graph, rather than
    // the link simply vanishing from it.
    expect(s.outgoingLinks("N.md").references.map((r) => r.resolution.status)).toEqual(["ambiguous"]);
    // An ambiguous reference produces no backlink on either candidate.
    expect(s.backlinks("a/Dup.md").references).toHaveLength(0);
    expect(s.backlinks("b/Dup.md").references).toHaveLength(0);
  });

  it("distinguishes missing, invalid, external and resolved targets", async () => {
    const { session: s } = await session({ "N.md": "# N\n", "Target.md": "# T\n" });
    expect(s.resolveLink("N.md", "Target").status).toBe("resolved");
    expect(s.resolveLink("N.md", "Nope").status).toBe("missing");
    expect(s.resolveLink("N.md", "https://example.com").status).toBe("external");
    expect(s.resolveLink("N.md", "/absolute").status).toBe("invalid");
    expect(s.resolveLink("Ghost.md", "Target").status).toBe("unavailable");
  });
});

describe("write refusals through the SDK", () => {
  it("keeps each refusal's distinct status", async () => {
    const { session: s } = await session({ "Target.md": "# T\n" });
    const statuses = {
      traversal: (await s.createNote("../Escape.md", "x")).status,
      absolute: (await s.createNote("/Escape.md", "x")).status,
      dotSegment: (await s.createNote(".secret/N.md", "x")).status,
      notANote: (await s.createNote("asset.png", "x")).status,
      duplicate: (await s.createNote("Target.md", "x")).status,
      caseCollision: (await s.createNote("TARGET.md", "x")).status,
      missingUpdate: (await s.updateNote("Nope.md", "x")).status,
      missingDelete: (await s.deleteNote("Nope.md")).status,
    };
    expect(statuses).toEqual({
      traversal: "invalid-path", absolute: "invalid-path", dotSegment: "invalid-path",
      notANote: "not-a-note", duplicate: "already-exists",
      caseCollision: "portability-collision", missingUpdate: "absent", missingDelete: "absent",
    });
  });
});
