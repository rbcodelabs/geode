/**
 * Regression: the file-backed sidebar panels (Comments, Backlinks, Outline)
 * used to cache their subject from the `file-open` payload alone. `file-open`
 * is emitted only when the newly active leaf's view answers `getFile()`
 * (workspace.ts `TabGroup.setActiveLeaf`), so activating a fileless view — a
 * web view — emitted nothing and stranded the previous note's content on
 * screen. `active-leaf-change` is unconditional and is the signal the panels
 * must also listen to, recomputing the subject via `workspace.getActiveFile()`.
 *
 * Driven through the real `Events` bus against a workspace stub that
 * reproduces workspace.ts's emission rules exactly, including the fact that a
 * focused sidebar leaf never becomes the workspace's active group.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Events } from "../../src/renderer/events";
import { UNLINKED_MENTIONS_SCAN } from "../../src/renderer/metadata-cache";
import type { TFile } from "../../src/renderer/types";
import { CommentsView } from "../../src/renderer/views/comments-view";
import { BacklinksView, OutlineView } from "../../src/renderer/views/sidebar-views";

class FakeElement {
  className = "";
  tabIndex = 0;
  type = "";
  checked = false;
  isConnected = true;
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private ownText = "";
  private html = "";

  set innerHTML(value: string) {
    // Assigning innerHTML replaces the whole subtree, empty string or not —
    // `empty()` relies on that to discard the previous note's rows.
    this.html = value;
    this.ownText = "";
    this.children.length = 0;
  }
  get innerHTML(): string {
    return this.html;
  }
  set textContent(value: string) {
    this.children.length = 0;
    this.ownText = value;
  }
  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  /** `SidebarView.isShowing` asks whether a hidden host is above it; this fake is never inside one. */
  closest(): FakeElement | null {
    return null;
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  append(...items: (FakeElement | string)[]): void {
    for (const item of items) {
      if (typeof item === "string") this.ownText += item;
      else this.children.push(item);
    }
  }
  replaceChildren(...items: FakeElement[]): void {
    this.children.length = 0;
    this.ownText = "";
    this.html = "";
    this.append(...items);
  }
  setAttribute(): void {}
  addEventListener(): void {}

  /**
   * Everything this subtree paints, however it painted it — these views mix
   * textContent, append() and innerHTML, so assertions read all three.
   */
  visibleText(): string {
    return [this.html, this.ownText, ...this.children.map((child) => child.visibleText())].join(" ");
  }
}

function markdownFile(path: string): TFile {
  const name = path.split("/").at(-1)!;
  return {
    kind: "file",
    path,
    name,
    basename: name.replace(/\.md$/, ""),
    extension: "md",
    mtime: 0,
    ctime: 0,
    size: 0,
    parent: "",
  } as TFile;
}

interface FakeLeaf {
  view: { getFile?: () => TFile | null };
}

/** A leaf whose view answers getFile() — MarkdownView. */
function markdownLeaf(file: TFile): FakeLeaf {
  return { view: { getFile: () => file } };
}

/**
 * A leaf whose view has no getFile at all — this is exactly WebView, which
 * declares `viewType = "webviewer"` and never implements the optional
 * `View.getFile`.
 */
function webViewLeaf(): FakeLeaf {
  return { view: {} };
}

/**
 * Mirrors the parts of `Workspace`/`TabGroup` that matter here:
 *
 * - `active-leaf-change` fires on every activation (workspace.ts:902);
 * - `file-open` fires only behind `if (file)` where `file = leaf.view?.getFile?.()`
 *   (workspace.ts:904);
 * - `getActiveFile()` derives from `activeGroup.active` (workspace.ts:2568);
 * - a sidebar leaf never assigns `activeGroup` — `TabGroup.setActiveLeaf` calls
 *   `workspace.setActiveGroup(this)` only when `!this.sidebar` (workspace.ts:898).
 */
class FakeWorkspace extends Events {
  private centreLeaf: FakeLeaf | null = null;

  activate(leaf: FakeLeaf, options: { sidebar?: boolean } = {}): void {
    if (!options.sidebar) this.centreLeaf = leaf;
    this.trigger("active-leaf-change", leaf);
    const file = leaf.view?.getFile?.();
    if (file) this.trigger("file-open", file);
  }

  getActiveFile(): TFile | null {
    return this.centreLeaf?.view?.getFile?.() ?? null;
  }
}

function makeApp(workspace: FakeWorkspace) {
  const metadataCache = new Events() as Events & Record<PropertyKey, any>;
  metadataCache.getBacklinksWithContext = vi.fn(async (file: TFile) => [
    { source: markdownFile("Linker.md"), count: 1, snippets: [`mentions ${file.basename}`] },
  ]);
  metadataCache.isUnlinkedMentionsReady = vi.fn(() => false);
  metadataCache[UNLINKED_MENTIONS_SCAN] = vi.fn(async () => []);
  metadataCache.getHeadings = vi.fn((file: TFile) => [
    { heading: `Heading of ${file.basename}`, level: 1, position: { start: { offset: 0 } } },
  ]);

  const comments = new Events() as Events & Record<PropertyKey, any>;
  comments.inspect = vi.fn(() => ({ errors: [] }));
  comments.list = vi.fn((file: TFile) => [
    {
      id: "c1",
      anchorText: `anchor in ${file.basename}`,
      detached: false,
      resolvedAt: null,
      messages: [{ id: "m1", body: `note on ${file.basename}`, author: { name: "Rick", type: "human" } }],
    },
  ]);

  return { workspace, metadataCache, comments, openFile: vi.fn() } as any;
}

const BLANK = "No file is open.";

describe("file-backed sidebar panels follow the active leaf", () => {
  const originalDocument = globalThis.document;

  beforeEach(() => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => new FakeElement() },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  });

  async function mountPanels() {
    const workspace = new FakeWorkspace();
    const app = makeApp(workspace);
    const note = markdownFile("Note.md");

    const comments = new CommentsView(app);
    const backlinks = new BacklinksView(app);
    const outline = new OutlineView(app);

    workspace.activate(markdownLeaf(note));
    for (const view of [comments, backlinks, outline]) await view.onOpen();
    await Promise.resolve();

    const body = (view: CommentsView | BacklinksView | OutlineView) =>
      ((view as any).bodyEl as FakeElement).visibleText();

    return { workspace, app, note, comments, backlinks, outline, body };
  }

  it("blanks every panel when the active leaf becomes a fileless web view", async () => {
    const { workspace, comments, backlinks, outline, body } = await mountPanels();

    expect(body(comments)).toContain("note on Note");
    expect(body(backlinks)).toContain("Linked mentions");
    expect(body(outline)).toContain("Heading of Note");

    workspace.activate(webViewLeaf());
    await Promise.resolve();

    expect(body(comments)).toContain(BLANK);
    expect(body(comments)).not.toContain("note on Note");
    expect(body(backlinks)).toContain(BLANK);
    expect(body(backlinks)).not.toContain("Linked mentions");
    expect(body(outline)).toContain(BLANK);
    expect(body(outline)).not.toContain("Heading of Note");
  });

  it("restores every panel when the active leaf returns to a markdown view", async () => {
    const { workspace, note, comments, backlinks, outline, body } = await mountPanels();

    workspace.activate(webViewLeaf());
    await Promise.resolve();
    expect(body(outline)).toContain(BLANK);

    workspace.activate(markdownLeaf(note));
    await Promise.resolve();
    await Promise.resolve();

    expect(body(comments)).toContain("note on Note");
    expect(body(backlinks)).toContain("Linked mentions");
    expect(body(outline)).toContain("Heading of Note");
  });

  it("keeps every panel populated when the user clicks into the sidebar itself", async () => {
    const { workspace, comments, backlinks, outline, body } = await mountPanels();

    // A sidebar leaf becoming active fires active-leaf-change but never
    // reassigns the workspace's active group, so getActiveFile() is unchanged.
    workspace.activate(webViewLeaf(), { sidebar: true });
    await Promise.resolve();

    expect(body(comments)).toContain("note on Note");
    expect(body(backlinks)).toContain("Linked mentions");
    expect(body(outline)).toContain("Heading of Note");
  });

  it("does not re-render when the active leaf change resolves to the same file", async () => {
    const { workspace, app, note, outline } = await mountPanels();
    app.metadataCache.getHeadings.mockClear();

    workspace.activate(markdownLeaf(note));
    await Promise.resolve();

    expect(app.metadataCache.getHeadings).not.toHaveBeenCalled();
  });

  it("still re-renders Comments when the comment service reports a change", async () => {
    const { app, note, comments, body } = await mountPanels();
    app.comments.list.mockImplementation(() => []);

    app.comments.trigger("changed", note);

    expect(body(comments)).toContain("No comments in this note.");
  });
});
