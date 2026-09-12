import { describe, expect, it } from "vitest";
import { App } from "../../src/renderer/app";
import { WorkspaceLeaf } from "../../src/renderer/workspace";
import type { HeadingCache, TFile } from "../../src/renderer/types";

/**
 * `OpenViewState.eState` used to be discarded outright by
 * `WorkspaceLeaf.openFile`, so a plugin that resolved a `Note#Heading` link
 * with `parseLinktext` and passed `{ eState: { subpath } }` got the right
 * file opened at the top of the document, silently, with no error. These
 * tests pin the two halves of the fix: resolving an anchor to an offset, and
 * routing that offset into the newly mounted view.
 */

const FILE = { path: "Note.md", basename: "Note", extension: "md" } as TFile;

function heading(text: string, level: number, offset: number): HeadingCache {
  return {
    heading: text,
    level,
    position: { start: { line: 0, col: 0, offset }, end: { line: 0, col: 0, offset } },
  } as HeadingCache;
}

/** An `App` with only the two collaborators `resolveSubpathOffset` touches. */
function stubApp(headings: HeadingCache[], content: string): App {
  const app = Object.create(App.prototype) as App;
  Object.assign(app, {
    metadataCache: { getHeadings: () => headings },
    vault: { cachedRead: async () => content },
  });
  return app;
}

const HEADINGS = [heading("Alpha", 1, 0), heading("Beta Section", 2, 120)];
const CONTENT = ["# Alpha", "text", "", "## Beta Section", "a claim ^claim-1", "tail"].join("\n");

describe("App.resolveSubpathOffset", () => {
  it("resolves a heading anchor to its start offset", async () => {
    const app = stubApp(HEADINGS, CONTENT);
    expect(await app.resolveSubpathOffset(FILE, "#Beta Section")).toBe(120);
    expect(await app.resolveSubpathOffset(FILE, "#Alpha")).toBe(0);
  });

  it("matches heading text case-insensitively, with or without the leading #", async () => {
    const app = stubApp(HEADINGS, CONTENT);
    expect(await app.resolveSubpathOffset(FILE, "#beta section")).toBe(120);
    expect(await app.resolveSubpathOffset(FILE, "Beta Section")).toBe(120);
  });

  it("resolves a block anchor to the start of the line carrying the marker", async () => {
    const app = stubApp(HEADINGS, CONTENT);
    const expected = CONTENT.indexOf("a claim ^claim-1");
    expect(await app.resolveSubpathOffset(FILE, "#^claim-1")).toBe(expected);
  });

  it("returns null for anchors that do not resolve", async () => {
    const app = stubApp(HEADINGS, CONTENT);
    expect(await app.resolveSubpathOffset(FILE, "#Nonexistent")).toBeNull();
    expect(await app.resolveSubpathOffset(FILE, "#^no-such-block")).toBeNull();
    expect(await app.resolveSubpathOffset(FILE, "#")).toBeNull();
    expect(await app.resolveSubpathOffset(FILE, "")).toBeNull();
    expect(await app.resolveSubpathOffset(FILE, "#^")).toBeNull();
  });

  it("treats an unreadable file as unresolved rather than throwing", async () => {
    const app = Object.create(App.prototype) as App;
    Object.assign(app, {
      metadataCache: { getHeadings: () => [] },
      vault: { cachedRead: async () => { throw new Error("gone"); } },
    });
    await expect(app.resolveSubpathOffset(FILE, "#^claim-1")).resolves.toBeNull();
  });
});

describe("WorkspaceLeaf.openFile honours eState.subpath", () => {
  function stubLeaf(resolved: number | null) {
    const scrolled: number[] = [];
    const opened: TFile[] = [];
    const leaf = Object.create(WorkspaceLeaf.prototype) as WorkspaceLeaf;
    Object.assign(leaf, {
      app: {
        openFileInLeaf: async (_leaf: unknown, file: TFile) => void opened.push(file),
        resolveSubpathOffset: async () => resolved,
      },
      view: { scrollToOffset: (offset: number) => void scrolled.push(offset) },
    });
    return { leaf, scrolled, opened };
  }

  it("scrolls the newly mounted view to the resolved anchor", async () => {
    const { leaf, scrolled, opened } = stubLeaf(120);
    await leaf.openFile(FILE, { eState: { subpath: "#Beta Section" } });
    expect(opened).toEqual([FILE]);
    expect(scrolled).toEqual([120]);
  });

  it("does not scroll when no subpath was requested", async () => {
    const { leaf, scrolled, opened } = stubLeaf(120);
    await leaf.openFile(FILE);
    await leaf.openFile(FILE, { eState: {} });
    await leaf.openFile(FILE, { eState: { subpath: "" } });
    expect(opened).toHaveLength(3);
    expect(scrolled).toEqual([]);
  });

  it("leaves the view at the top when the anchor does not resolve", async () => {
    const { leaf, scrolled } = stubLeaf(null);
    await leaf.openFile(FILE, { eState: { subpath: "#Nonexistent" } });
    expect(scrolled).toEqual([]);
  });

  it("is a no-op on a view that cannot scroll, rather than throwing", async () => {
    const leaf = Object.create(WorkspaceLeaf.prototype) as WorkspaceLeaf;
    Object.assign(leaf, {
      app: { openFileInLeaf: async () => {}, resolveSubpathOffset: async () => 120 },
      view: { viewType: "some-plugin-view" },
    });
    await expect(leaf.openFile(FILE, { eState: { subpath: "#Beta" } })).resolves.toBeUndefined();
  });
});
