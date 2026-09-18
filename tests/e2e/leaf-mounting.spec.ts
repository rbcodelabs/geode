import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Tab activation hides the outgoing leaf instead of detaching it. These tests
 * pin the two halves of that contract against the real app, because both are
 * invisible to a unit test:
 *
 * - the payoff — a `<webview>` guest is destroyed by Electron the moment its
 *   element leaves the document, so the old detach-on-switch behaviour handed
 *   back a brand new guest (and a reloaded page) every time the user returned
 *   to a Web Viewer tab;
 * - the constraint — a leaf that has never been revealed must still not be in
 *   the document at all, so restoring a large workspace does not mount (and,
 *   for Web Viewer tabs, spawn a guest process for) every saved tab at once.
 */

async function launch(files: Record<string, string> = {}, workspaceJson?: unknown) {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-leaf-mount-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-leaf-mount-ud-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(vaultDir, name), content);
  }
  if (workspaceJson) {
    fs.mkdirSync(path.join(vaultDir, ".geode"), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, ".geode", "workspace.json"), JSON.stringify(workspaceJson));
  }
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  const consoleErrors: string[] = [];
  window.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  window.on("pageerror", (err) => consoleErrors.push(String(err)));
  await expect(window.locator(".workspace")).toBeVisible();
  await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
  const cleanup = () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  return { app, window, vaultDir, consoleErrors, cleanup };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind to TCP");
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

/** Live guests, resolved in main — the only authority on what actually exists. */
const liveGuestIds = (app: ElectronApplication) =>
  app.evaluate(({ webContents }) =>
    webContents.getAllWebContents()
      .filter((contents) => contents.getType() === "webview")
      .map((contents) => contents.id)
      .sort((a, b) => a - b));

/** `leafEl`s currently in the center group's content host, active one first. */
const mountedLeafIds = (window: Page) =>
  window.evaluate(() => {
    const group = (window as any).app.workspace.activeGroup;
    const host: HTMLElement = group.contentHostEl;
    return {
      mounted: [...host.children].map((child) => (child as HTMLElement).dataset.leafProbeId ?? "?"),
      visible: [...host.children]
        .filter((child) => child.classList.contains("mod-active"))
        .map((child) => (child as HTMLElement).dataset.leafProbeId ?? "?"),
      tabs: group.leaves.length,
    };
  });

/** Stamp every leaf element in the active group so the DOM can be read by id. */
const stampLeafIds = (window: Page) =>
  window.evaluate(() => {
    for (const leaf of (window as any).app.workspace.activeGroup.leaves) {
      leaf.leafEl.dataset.leafProbeId = leaf.id;
    }
  });

test("a Web Viewer tab keeps its guest and its page state across a tab switch", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const page = request.url === "/b" ? "Page B" : "Page A";
    response.end(`<!doctype html><html><head><title>${page}</title></head><body><h1>${page}</h1></body></html>`);
  });
  const port = await listen(server);
  const urlA = `http://127.0.0.1:${port}/a`;
  const urlB = `http://127.0.0.1:${port}/b`;
  const { app, window, consoleErrors, cleanup } = await launch();

  try {
    await window.evaluate(async (url) => {
      const geode = (window as any).app;
      const leaf = geode.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__leafA = leaf;
    }, urlA);

    const activeFrame = window.locator(".workspace-split.mod-root .workspace-leaf.mod-active .web-view-frame");
    await expect.poll(() => activeFrame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL())).toBe(urlA);
    const guestA = await activeFrame.evaluate((guest) =>
      (guest as unknown as { getWebContentsId(): number }).getWebContentsId());

    // A value that only survives if this exact JS context survives. A reload
    // of the same URL would leave the URL and the tab looking identical.
    await activeFrame.evaluate((guest) =>
      (guest as unknown as { executeJavaScript(s: string): Promise<unknown> })
        .executeJavaScript("window.__survivor = 'kept'; 'ok'"));

    await window.evaluate(async (url) => {
      const geode = (window as any).app;
      const leaf = geode.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__leafB = leaf;
    }, urlB);
    await expect.poll(() => activeFrame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL())).toBe(urlB);

    // Tab A is hidden, not gone: its guest is still alive while B is in front.
    expect(await liveGuestIds(app)).toHaveLength(2);
    expect(await liveGuestIds(app)).toContain(guestA);

    await window.evaluate(() => {
      const leaf = (window as any).__leafA;
      leaf.group.setActiveLeaf(leaf);
    });
    await expect.poll(() => activeFrame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL())).toBe(urlA);

    // The assertion this whole change exists for: same guest, same page.
    expect(await activeFrame.evaluate((guest) =>
      (guest as unknown as { getWebContentsId(): number }).getWebContentsId())).toBe(guestA);
    expect(await activeFrame.evaluate((guest) =>
      (guest as unknown as { executeJavaScript(s: string): Promise<unknown> })
        .executeJavaScript("window.__survivor ?? 'lost'"))).toBe("kept");

    // Closing the background tab must actually release its guest — a hidden
    // leaf is still a child of the content host, so a close path that forgot
    // to unmount it would leak a renderer process per closed tab.
    expect(await liveGuestIds(app)).toHaveLength(2);
    await window.evaluate(async () => { await (window as any).__leafB.detach(); });
    await expect.poll(() => liveGuestIds(app)).toEqual([guestA]);
    expect(await window.evaluate(() => {
      const host = (window as any).app.workspace.activeGroup.contentHostEl as HTMLElement;
      return host.contains((window as any).__leafB.leafEl);
    })).toBe(false);

    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  } finally {
    await app.close();
    await closeServer(server);
    cleanup();
  }
});

test("a docked Web Viewer pane keeps its guest across a sidebar pane switch", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Docked</title></head><body><h1>Docked</h1></body></html>");
  });
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}/docked`;
  const { app, window, consoleErrors, cleanup } = await launch();

  try {
    await window.evaluate(async (target) => {
      const geode = (window as any).app;
      const leaf = geode.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url: target } });
      geode.workspace.revealLeaf(leaf);
    }, url);

    const dockedFrame = window.locator(".workspace-sidebar.mod-right .web-view-frame");
    await expect.poll(() => dockedFrame.evaluate((guest) =>
      (guest as unknown as { getURL(): string }).getURL())).toBe(url);
    const guestId = await dockedFrame.evaluate((guest) =>
      (guest as unknown as { getWebContentsId(): number }).getWebContentsId());
    await dockedFrame.evaluate((guest) =>
      (guest as unknown as { executeJavaScript(s: string): Promise<unknown> })
        .executeJavaScript("window.__survivor = 'kept'; 'ok'"));

    // Switch the dock to a built-in pane and back.
    await window.evaluate(() => {
      const sidebar = (window as any).app.workspace.rightSidebar;
      sidebar.show(sidebar.views.find((view: { viewType: string }) => view.viewType === "outline"));
    });
    await expect(window.locator(".workspace-sidebar.mod-right .sidebar-view.mod-active .sidebar-view-title"))
      .toHaveText("Outline");
    await expect(dockedFrame).toBeHidden();
    expect(await liveGuestIds(app)).toHaveLength(1);

    await window.evaluate(() => {
      const sidebar = (window as any).app.workspace.rightSidebar;
      const leaf = sidebar.leaves.find((candidate: { view?: { viewType: string } }) => candidate.view?.viewType === "webviewer");
      sidebar.show(leaf);
    });
    await expect(dockedFrame).toBeVisible();
    expect(await dockedFrame.evaluate((guest) =>
      (guest as unknown as { getWebContentsId(): number }).getWebContentsId())).toBe(guestId);
    expect(await dockedFrame.evaluate((guest) =>
      (guest as unknown as { executeJavaScript(s: string): Promise<unknown> })
        .executeJavaScript("window.__survivor ?? 'lost'"))).toBe("kept");

    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  } finally {
    await app.close();
    await closeServer(server);
    cleanup();
  }
});

test("a restored tab is mounted only once it is first revealed, and stays mounted after", async () => {
  const workspaceJson = {
    version: 2,
    center: {
      root: {
        type: "tabs",
        leaves: [
          { type: "markdown", file: "One.md" },
          { type: "markdown", file: "Two.md" },
          { type: "markdown", file: "Three.md" },
        ],
        active: 0,
      },
      activeGroup: 0,
    },
    left: { root: { type: "tabs", leaves: [{ type: "file-explorer" }], active: 0 }, collapsed: false, width: 280 },
    right: { root: { type: "tabs", leaves: [] as unknown[], active: 0 }, collapsed: false, width: 280 },
  };
  const { app, window, consoleErrors, cleanup } = await launch(
    {
      "One.md": "# One\n\nfirst note\n",
      "Two.md": "# Two\n\nsecond note\n",
      "Three.md": "# Three\n\nthird note\n",
    },
    workspaceJson
  );

  try {
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header")).toHaveCount(3);
    await stampLeafIds(window);
    const leafIds = await window.evaluate(() =>
      (window as any).app.workspace.activeGroup.leaves.map((leaf: { id: string }) => leaf.id));
    expect(leafIds).toHaveLength(3);

    // Restore activates every leaf it builds, so this is the guard that a
    // bulk restore does not mount all of them.
    expect(await mountedLeafIds(window)).toEqual({ mounted: [leafIds[0]], visible: [leafIds[0]], tabs: 3 });

    const activeEditor = window.locator(".workspace-leaf.mod-active .cm-content");
    await expect(activeEditor).toContainText("first note");

    await window.evaluate((id) => {
      const leaf = (window as any).app.workspace.activeGroup.leaves.find((l: { id: string }) => l.id === id);
      leaf.group.setActiveLeaf(leaf);
    }, leafIds[1]);
    await expect(activeEditor).toContainText("second note");
    expect(await mountedLeafIds(window)).toEqual({
      mounted: [leafIds[0], leafIds[1]],
      visible: [leafIds[1]],
      tabs: 3,
    });

    // Back to the first tab: it was never re-appended, so its editor state and
    // element identity are the ones it has had since restore.
    await window.evaluate((id) => {
      const leaf = (window as any).app.workspace.activeGroup.leaves.find((l: { id: string }) => l.id === id);
      leaf.group.setActiveLeaf(leaf);
    }, leafIds[0]);
    await expect(activeEditor).toContainText("first note");
    expect(await mountedLeafIds(window)).toEqual({
      mounted: [leafIds[0], leafIds[1]],
      visible: [leafIds[0]],
      tabs: 3,
    });

    // The hidden tab is laid out at zero size while it is in the background;
    // the revealed one must be measured again, or CodeMirror paints against
    // the geometry it cached while hidden.
    const editorBox = await window.locator(".workspace-leaf.mod-active .cm-content").boundingBox();
    expect(editorBox?.height ?? 0).toBeGreaterThan(0);
    expect(editorBox?.width ?? 0).toBeGreaterThan(0);

    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  } finally {
    await app.close();
    cleanup();
  }
});
