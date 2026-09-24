/**
 * Regression: an internal link clicked in a pane that was not yet the active
 * pane opened its file in the *previously* active pane.
 *
 * The cause is an event-ordering race, not anything about the linked file.
 * Live Preview routes internal links on `mousedown`, which bubbles
 * target-first, while the listener that promotes a pane to active lives on an
 * ancestor (`TabGroup`'s constructor: `containerEl.addEventListener("mousedown",
 * () => workspace.setActiveGroup(this))`). So on the *first* click into a pane,
 * the link handler runs first and synchronously reaches
 * `App.openFile -> Workspace.getLeaf(false) -> getActiveLeaf()` while
 * `activeGroup` still names the pane the user just left. Clicking anywhere in
 * the pane beforehand hid the bug, because that earlier click had already
 * promoted the group.
 *
 * `.base` files surfaced it most often because they are usually not already
 * open, so `openFile`'s `findLeafForFile` short-circuit does not fire and the
 * `getLeaf(false)` path is forced — but `.md` and images share that exact
 * branch and were equally affected.
 *
 * These tests drive the real `Workspace.getLeaf`, `App.openFile` and
 * `App.openLink` through a faithful target-first dispatch, with the active
 * group deliberately left stale at the moment the link handler runs.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import { TabGroup, Workspace, type WorkspaceLeaf } from "../../src/renderer/workspace";
import type { TFile } from "../../src/renderer/types";

function file(filePath: string): TFile {
  const name = filePath.split("/").at(-1)!;
  const extension = name.includes(".") ? name.split(".").at(-1)! : "";
  return {
    kind: "file",
    path: filePath,
    name,
    basename: name.replace(`.${extension}`, ""),
    extension,
    mtime: 0,
    ctime: 0,
    size: 0,
    parent: "",
  } as TFile;
}

/**
 * The one DOM property this regression is about: a `mousedown` runs every
 * listener on the target before any listener on an ancestor. Nothing else
 * about events is modelled, because nothing else is implicated.
 */
class FakeEventTarget {
  parent: FakeEventTarget | null = null;
  private listeners = new Map<string, ((event: any) => void)[]>();

  addEventListener(type: string, fn: (event: any) => void): void {
    const existing = this.listeners.get(type);
    if (existing) existing.push(fn);
    else this.listeners.set(type, [fn]);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (let node: FakeEventTarget | null = this; node; node = node.parent) {
      for (const fn of node.listeners.get(type) ?? []) fn({ preventDefault() {}, ...event });
    }
  }
}

interface Opened {
  leaf: WorkspaceLeaf;
  file: TFile;
}

function scenario(vaultFiles: TFile[]) {
  const workspace = Object.create(Workspace.prototype) as Workspace &
    Record<PropertyKey, any>;
  const app = Object.create(App.prototype) as App & Record<PropertyKey, any>;
  const opened: Opened[] = [];

  function makeGroup(isSidebar: boolean): TabGroup & Record<PropertyKey, any> {
    const group = Object.create(TabGroup.prototype) as TabGroup & Record<PropertyKey, any>;
    Object.assign(group, {
      workspace,
      app,
      leaves: [],
      collections: [],
      isSidebar,
      sidebar: isSidebar ? {} : undefined,
      renderTabs: vi.fn(),
      contentHostEl: { children: [], appendChild() {} },
      // `TabGroup.setActiveLeaf` is not what this regression is about; the real
      // one reaches deep into DOM reveal. Only its observable effect matters:
      // the group remembers its visible tab, and a main-area group becoming
      // active reassigns `workspace.activeGroup`.
      setActiveLeaf(leaf: WorkspaceLeaf) {
        group.active = leaf;
        if (!isSidebar) workspace.setActiveGroup(group);
      },
    });
    return group;
  }

  const left = makeGroup(false);
  const right = makeGroup(false);
  const sidebarGroup = makeGroup(true);

  Object.assign(workspace, {
    layoutReady: true,
    groups: [left, right],
    leftSidebar: { groups: [] },
    rightSidebar: { groups: [] },
    activeGroup: left,
    trigger: vi.fn(),
    syncAdaptivePresentation: vi.fn(),
  });

  const byLinktext = new Map(vaultFiles.map((f) => [f.basename, f]));
  Object.assign(app, {
    workspace,
    metadataCache: {
      getFirstLinkpathDest: (linktext: string) => byLinktext.get(linktext) ?? null,
    },
    // Stubbed: mounting a real view needs the whole renderer. What this test
    // asserts is *which leaf* the file was handed to, which is decided before
    // this point.
    openFileInLeaf: vi.fn(async (leaf: WorkspaceLeaf, f: TFile) => {
      opened.push({ leaf, file: f });
      (leaf as any).view = { getFile: () => f, viewType: "markdown" };
    }),
  });

  // Each pane starts with one open document, as a real two-pane layout does.
  const leftLeaf = left.createLeaf();
  (leftLeaf as any).view = { getFile: () => file("Left.md"), viewType: "markdown" };
  const rightLeaf = right.createLeaf();
  (rightLeaf as any).view = { getFile: () => file("Right.md"), viewType: "markdown" };

  // `createLeaf` promoted the right group; put the workspace back in the state
  // the bug needs — the user is in the left pane and has not yet clicked into
  // the right one.
  workspace.activeGroup = left;

  /**
   * The DOM shape a Live Preview link click travels through: the anchor sits
   * inside the pane container that carries the pane-activation listener, which
   * is installed exactly as `TabGroup`'s constructor installs it.
   */
  function pane(group: TabGroup) {
    const container = new FakeEventTarget();
    container.addEventListener("mousedown", () => workspace.setActiveGroup(group));
    const link = new FakeEventTarget();
    link.parent = container;
    return link;
  }

  return { app, workspace, left, right, sidebarGroup, leftLeaf, rightLeaf, opened, pane };
}

const originalDocument = globalThis.document;
beforeEach(() => {
  vi.stubGlobal("document", {
    createElement: () => ({ appendChild() {}, className: "", classList: { add() {}, remove() {}, toggle() {} } }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
});

describe("an internal link opens in the pane it was clicked in", () => {
  /**
   * The exact case the user hit: a `.base` link, in a right-hand pane that was
   * not yet active, clicked with no prior focusing click.
   */
  it("opens a .base link in the clicking pane on the very first click into it", async () => {
    const target = file("Data.base");
    const { app, workspace, right, rightLeaf, opened, pane } = scenario([target]);
    const link = pane(right);

    expect(workspace.activeGroup).not.toBe(right); // the pane is cold

    let navigation: Promise<void> | undefined;
    link.addEventListener("mousedown", (e: any) => {
      e.preventDefault();
      // Exactly what the Live Preview handlers now do: hand over the leaf the
      // click came from instead of leaving the destination to global state.
      navigation = app.openLink("Data", "Right.md", false, rightLeaf);
    });

    link.dispatch("mousedown", { metaKey: false, ctrlKey: false });
    await navigation;

    expect(opened).toHaveLength(1);
    expect(opened[0].file.path).toBe("Data.base");
    expect(opened[0].leaf.group).toBe(right);
  });

  it("opens a .md link in the clicking pane too — the branch is shared, not .base-specific", async () => {
    const target = file("Notes.md");
    const { app, right, rightLeaf, opened, pane } = scenario([target]);
    const link = pane(right);

    let navigation: Promise<void> | undefined;
    link.addEventListener("mousedown", () => {
      navigation = app.openLink("Notes", "Right.md", false, rightLeaf);
    });
    link.dispatch("mousedown");
    await navigation;

    expect(opened[0].leaf.group).toBe(right);
  });

  it("reuses the clicking leaf itself rather than adding a tab", async () => {
    const { app, right, rightLeaf, opened, pane } = scenario([file("Data.base")]);
    const link = pane(right);

    let navigation: Promise<void> | undefined;
    link.addEventListener("mousedown", () => {
      navigation = app.openLink("Data", "Right.md", false, rightLeaf);
    });
    link.dispatch("mousedown");
    await navigation;

    expect(opened[0].leaf).toBe(rightLeaf);
    expect(right.leaves).toHaveLength(1);
  });

  it("adds the new tab beside the clicking leaf when the link is cmd-clicked", async () => {
    const { app, right, rightLeaf, opened, pane } = scenario([file("Data.base")]);
    const link = pane(right);

    let navigation: Promise<void> | undefined;
    link.addEventListener("mousedown", () => {
      navigation = app.openLink("Data", "Right.md", true, rightLeaf);
    });
    link.dispatch("mousedown");
    await navigation;

    expect(opened[0].leaf).not.toBe(rightLeaf);
    expect(opened[0].leaf.group).toBe(right);
    expect(right.leaves).toHaveLength(2);
  });

  it("respects a pinned clicking leaf by opening a new tab in that same pane", async () => {
    const { app, right, rightLeaf, opened, pane } = scenario([file("Data.base")]);
    rightLeaf.pinned = true;
    const link = pane(right);

    let navigation: Promise<void> | undefined;
    link.addEventListener("mousedown", () => {
      navigation = app.openLink("Data", "Right.md", false, rightLeaf);
    });
    link.dispatch("mousedown");
    await navigation;

    expect(opened[0].leaf).not.toBe(rightLeaf);
    expect(opened[0].leaf.group).toBe(right);
  });
});

describe("callers that mean the active pane are unaffected", () => {
  it("falls back to the active leaf when no source leaf is supplied", async () => {
    const { app, leftLeaf, opened } = scenario([file("Data.base")]);
    // The command palette / quick switcher / File Explorer shape.
    await app.openFile(file("Data.base"), false);
    expect(opened[0].leaf).toBe(leftLeaf);
  });

  it("ignores a source leaf docked in a sidebar and uses the active pane", async () => {
    const { app, sidebarGroup, leftLeaf, opened } = scenario([file("Data.base")]);
    const docked = sidebarGroup.createLeaf();

    await app.openFile(file("Data.base"), false, docked);

    // A link clicked in a sidebar note opens in the main area, matching
    // Obsidian — and `activeGroup` is only ever a main-area group.
    expect(opened[0].leaf).toBe(leftLeaf);
  });

  it("ignores a source leaf that has since been closed out of its pane", async () => {
    const { app, right, rightLeaf, leftLeaf, opened } = scenario([file("Data.base")]);
    right.leaves.splice(right.leaves.indexOf(rightLeaf), 1);

    await app.openFile(file("Data.base"), false, rightLeaf);

    expect(opened[0].leaf).toBe(leftLeaf);
  });
});

/**
 * The tests above prove the destination logic. This one guards the wiring that
 * feeds it: every in-app internal-link handler has to actually hand over its
 * leaf. A handler added later that forgets the argument silently reintroduces
 * the bug, and no behavioral unit test would catch it, because the handlers
 * live behind CodeMirror and a real DOM.
 */
describe("every internal-link handler forwards its originating leaf", () => {
  const sources = [
    "src/renderer/markdown/live-preview.ts",
    "src/renderer/markdown/render.ts",
    "src/renderer/views/markdown-view.ts",
  ];

  it.each(sources)("%s passes a leaf to every openLink call", (relative) => {
    const source = fs.readFileSync(path.resolve(__dirname, "../..", relative), "utf8");
    const calls = [...source.matchAll(/openLink\(([^;]*?)\);/g)].map((m) => m[1]);

    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args, `openLink(${args}) omits its originating leaf`).toMatch(/getLeaf|ownLeaf/);
    }
  });
});
