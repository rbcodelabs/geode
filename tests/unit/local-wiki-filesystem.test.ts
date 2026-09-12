import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { nodeWikiFileSystem, openLocalWikiSnapshot, type WikiFileSystem } from "../../src/wiki/local-filesystem";

const roots: string[] = [];
async function fixture(files: Record<string, string | Uint8Array>) {
  const root = await mkdtemp(join(tmpdir(), "geode-wiki-test-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function snapshot(root: string, options: Parameters<typeof openLocalWikiSnapshot>[1] = {}) {
  const result = await openLocalWikiSnapshot(root, options);
  if (result.status !== "ok") throw Error(JSON.stringify(result));
  return result.snapshot;
}

describe("bounded Node folder capture", () => {
  it("reads nested Markdown, indexes attachments without reading them and uses memory after open", async () => {
    const root = await fixture({ "nested/Source.MD": "[[Target]]", "Target.md": "# Target", "asset.png": new Uint8Array([0xff]) });
    const opened: string[] = [];
    const s = await snapshot(root, { filesystem: { ...nodeWikiFileSystem, open: async path => { opened.push(path); return nodeWikiFileSystem.open(path); } } });
    expect(s.listFiles().map(f => f.path)).toEqual(["Target.md", "asset.png", "nested/Source.MD"]);
    expect(opened.every(path => /\.md$/i.test(path))).toBe(true);
    expect(s.backlinks("Target.md").references).toHaveLength(1);
    await writeFile(join(root, "Target.md"), "changed");
    await rm(join(root, "nested/Source.MD"));
    expect(s.search("Target").hits).toHaveLength(2);
    expect(s.search("changed").hits).toEqual([]);
    expect(s.readNote("nested/Source.MD")).toMatchObject({ status: "ok" });
    expect((await snapshot(root)).search("changed").hits).toHaveLength(1);
    expect(s.info).toMatchObject({ consistency: "scan", discoveryComplete: true, noteContentComplete: true });
    expect(JSON.stringify(s.info)).not.toContain(root);
  });

  it("excludes hidden paths and node_modules directories at every depth", async () => {
    const root = await fixture({ ".hidden/a.md": "secret", "a/.hidden.md": "secret", "node_modules/a.md": "secret", "a/node_modules/x.md": "secret", "visible.md": "yes" });
    const s = await snapshot(root);
    expect(s.listFiles().map(f => f.path)).toEqual(["visible.md"]);
    expect(s.search("secret").hits).toEqual([]);
    expect(s.info.diagnostics).toEqual([]);
  });

  it("canonicalizes a selected symlink root but skips all descendant symlinks", async () => {
    const root = await fixture({ "Target.md": "safe", "folder/Nested.md": "safe" });
    const outside = await fixture({ "private.md": "outside" });
    await symlink(join(root, "Target.md"), join(root, "internal.md"));
    await symlink(join(root, "folder"), join(root, "directory"));
    await symlink(root, join(root, "loop"));
    await symlink(join(outside, "private.md"), join(root, "external.md"));
    await symlink(join(root, "missing"), join(root, "broken.md"));
    await symlink(root, join(outside, "selected"));
    const s = await snapshot(join(outside, "selected"));
    expect(s.listFiles().map(f => f.path)).toEqual(["Target.md", "folder/Nested.md"]);
    expect(s.info.diagnostics.filter(d => d.code === "symlink-excluded").map(d => d.path).sort()).toEqual(["broken.md", "directory", "external.md", "internal.md", "loop"]);
  });

  it("retains unavailable identities for oversize, invalid encoding and read failures", async () => {
    const root = await fixture({ "big.md": "12345", "bad.md": new Uint8Array([0xc3, 0x28]), "denied.md": "1", "ok.md": "1234" });
    const s = await snapshot(root, { limits: { maxNoteBytes: 4 }, filesystem: { ...nodeWikiFileSystem, open: async path => {
      if (path.endsWith("/denied.md")) throw Error("private host path must not escape");
      return nodeWikiFileSystem.open(path);
    } } });
    expect(s.listFiles()).toHaveLength(4);
    for (const path of ["big.md", "bad.md", "denied.md"]) expect(s.readNote(path).status).toBe("unavailable");
    expect(s.readNote("ok.md").status).toBe("ok");
    expect(s.info.diagnostics.map(d => d.code).sort()).toEqual(["file-read-failed", "invalid-utf8", "note-byte-limit"]);
    expect(s.search("1").complete).toBe(false);
  });

  it("admits exact total byte boundary and leaves excess notes unavailable", async () => {
    const root = await fixture({ "a.md": "ab", "b.md": "cd" });
    expect((await snapshot(root, { limits: { maxTotalNoteBytes: 4 } })).info.noteContentComplete).toBe(true);
    const s = await snapshot(root, { limits: { maxTotalNoteBytes: 3 } });
    expect(s.listFiles()).toHaveLength(2);
    expect(s.search("a").complete).toBe(false);
    expect(s.info.diagnostics.some(d => d.code === "total-byte-limit")).toBe(true);
  });

  it("counts attachments against entry limits and handles the exact boundary", async () => {
    const root = await fixture({ "asset.png": "", "a.md": "" });
    expect((await snapshot(root, { limits: { maxEntries: 2 } })).info.discoveryComplete).toBe(true);
    const s = await snapshot(root, { limits: { maxEntries: 1 } });
    expect(s.listFiles()).toHaveLength(1);
    expect(s.info.discoveryComplete).toBe(false);
    expect(s.info.diagnostics.some(d => d.code === "entry-limit")).toBe(true);
  });

  it("bounds depth and stops incremental enumeration of even excluded entries", async () => {
    const root = await fixture({ "a.md": "", "dir/deep.md": "" });
    const shallow = await snapshot(root, { limits: { maxDepth: 1 } });
    expect(shallow.listFiles().map(f => f.path)).toEqual(["a.md"]);
    expect(shallow.info.diagnostics).toContainEqual({ code: "depth-limit", path: "dir" });
    let yielded = 0;
    let closed = false;
    const filesystem: WikiFileSystem = { ...nodeWikiFileSystem, entries: async function* () {
      try { for (let i = 0; i < 1000; i++) { yielded++; yield `.hidden${i}`; } }
      finally { closed = true; }
    } };
    const s = await snapshot(root, { limits: { maxVisitedEntries: 3 }, filesystem });
    expect(yielded).toBeLessThanOrEqual(4);
    expect(closed).toBe(true);
    expect(s.info.discoveryComplete).toBe(false);
    expect(s.info.diagnostics.some(d => d.code === "visited-entry-limit")).toBe(true);
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid limit %s before filesystem access", async maxEntries => {
    let accessed = false;
    const result = await openLocalWikiSnapshot("irrelevant", { limits: { maxEntries }, filesystem: { ...nodeWikiFileSystem, realpath: async () => { accessed = true; throw Error(); } } });
    expect(result).toMatchObject({ status: "error", error: { code: "invalid-limits" } });
    expect(accessed).toBe(false);
  });

  it("returns typed fatal root errors without host details", async () => {
    const root = await fixture({ "file.md": "" });
    expect(await openLocalWikiSnapshot(join(root, "missing"))).toEqual({ status: "error", error: { code: "root-unavailable" } });
    expect(await openLocalWikiSnapshot(join(root, "file.md"))).toEqual({ status: "error", error: { code: "root-not-directory" } });
  });

  it("skips special files without opening them", async () => {
    const root = await fixture({ "special.md": "unread" });
    let opened = false;
    const s = await snapshot(root, { filesystem: { ...nodeWikiFileSystem,
      lstat: async path => {
        const stat = await nodeWikiFileSystem.lstat(path);
        if (path.endsWith("/special.md")) { stat.isFile = () => false; stat.isDirectory = () => false; }
        return stat;
      },
      open: async path => { opened = true; return nodeWikiFileSystem.open(path); },
    } });
    expect(opened).toBe(false);
    expect(s.listFiles()).toEqual([]);
    expect(s.info.diagnostics).toContainEqual({ code: "special-file-excluded", path: "special.md" });
  });

  it("preserves a UTF-8 BOM and link offsets in original captured text", async () => {
    const text = "\ufeffprefix [[Target]]";
    const root = await fixture({ "Source.md": text, "Target.md": "" });
    const s = await snapshot(root);
    expect(s.readNote("Source.md")).toMatchObject({ status: "ok", note: { text } });
    const ref = s.outgoing("Source.md").references[0];
    expect(ref.position.start.offset).toBe(8);
    expect(text.slice(ref.position.start.offset, ref.position.end.offset)).toBe("[[Target]]");
  });
});

describe("observed filesystem races and failures", () => {
  it("rejects unexpected EOF after a short read without retaining partial content", async () => {
    const root = await fixture({ "a.md": "safe" });
    let closed = false;
    const s = await snapshot(root, { filesystem: { ...nodeWikiFileSystem, open: async path => {
      const handle = await nodeWikiFileSystem.open(path);
      return {
        stat: () => handle.stat(),
        close: async () => { closed = true; await handle.close(); },
        read: async (buffer, offset, _length, position) => position === 0 ? handle.read(buffer, offset, 1, position) : { bytesRead: 0 },
      };
    } } });
    expect(closed).toBe(true);
    expect(s.readNote("a.md").status).toBe("unavailable");
    expect(s.search("s").hits).toEqual([]);
    expect(s.info.diagnostics).toContainEqual({ code: "file-changed", path: "a.md" });
  });

  it("rejects a same-size replacement inode before reading its bytes", async () => {
    const root = await fixture({ "a.md": "safe", ".replacement": "evil" });
    const s = await snapshot(root, { filesystem: { ...nodeWikiFileSystem, open: async path => {
      await rename(join(root, ".replacement"), path);
      return nodeWikiFileSystem.open(path);
    } } });
    expect(s.readNote("a.md").status).toBe("unavailable");
    expect(s.search("evil").hits).toEqual([]);
    expect(s.info.diagnostics).toContainEqual({ code: "file-changed", path: "a.md" });
  });

  it("rejects final symlink replacement before open without reading outside bytes", async () => {
    const root = await fixture({ "a.md": "safe" });
    const outside = await fixture({ "secret.md": "outside" });
    const s = await snapshot(root, { filesystem: { ...nodeWikiFileSystem, open: async path => {
      await rm(path); await symlink(join(outside, "secret.md"), path);
      return nodeWikiFileSystem.open(path);
    } } });
    expect(s.readNote("a.md").status).toBe("unavailable");
    expect(s.search("outside").hits).toEqual([]);
  });

  it("rejects replacement inode and ancestor symlink swaps through the adapter", async () => {
    const root = await fixture({ "dir/a.md": "safe", "replacement.md": "different" });
    const outside = await fixture({ "a.md": "outside" });
    const s = await snapshot(root, { filesystem: { ...nodeWikiFileSystem, open: async path => {
      if (path.endsWith("/dir/a.md")) {
        await rename(join(root, "dir"), join(root, "moved"));
        await symlink(outside, join(root, "dir"));
      }
      return nodeWikiFileSystem.open(path);
    } } });
    expect(s.readNote("dir/a.md").status).toBe("unavailable");
    expect(s.search("outside").hits).toEqual([]);
  });

  it("rejects same inode mutation observed during bounded read and closes the handle", async () => {
    const root = await fixture({ "a.md": "safe" });
    let closed = false;
    const s = await snapshot(root, { filesystem: { ...nodeWikiFileSystem, open: async path => {
      const handle = await nodeWikiFileSystem.open(path);
      return {
        stat: () => handle.stat(),
        close: async () => { closed = true; await handle.close(); },
        read: async (buffer, offset, length, position) => {
          await writeFile(path, "changed content");
          return handle.read(buffer, offset, length, position);
        },
      };
    } } });
    expect(closed).toBe(true);
    expect(s.readNote("a.md").status).toBe("unavailable");
    expect(s.info.diagnostics).toContainEqual({ code: "file-changed", path: "a.md" });
  });

  it("rejects a sibling-prefix canonical escape and never opens the file", async () => {
    const root = await fixture({ "a.md": "safe" });
    let opened = false;
    const s = await snapshot(root, { filesystem: { ...nodeWikiFileSystem,
      realpath: path => path.endsWith("/a.md") ? Promise.resolve(root + "-outside/a.md") : nodeWikiFileSystem.realpath(path),
      open: async path => { opened = true; return nodeWikiFileSystem.open(path); },
    } });
    expect(opened).toBe(false);
    expect(s.readNote("a.md").status).toBe("unavailable");
    expect(s.info.diagnostics).toContainEqual({ code: "path-changed", path: "a.md" });
  });

  it("reports descendant listing/stat failures as incomplete discovery", async () => {
    const root = await fixture({ "denied/a.md": "", "bad.md": "", "good.md": "good" });
    const s = await snapshot(root, { filesystem: { ...nodeWikiFileSystem,
      entries: async function* (path) { if (path.endsWith("/denied")) throw Error(); yield* nodeWikiFileSystem.entries(path); },
      lstat: path => path.endsWith("/bad.md") ? Promise.reject(Error()) : nodeWikiFileSystem.lstat(path),
    } });
    expect(s.info.discoveryComplete).toBe(false);
    expect(s.info.diagnostics.map(d => d.code).sort()).toEqual(["directory-read-failed", "entry-stat-failed"]);
    expect(s.search("good")).toMatchObject({ complete: false, hits: [{ path: "good.md" }] });
  });
});
