import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const isMac = process.platform === "darwin";
const MOD = isMac ? "meta" : "control";
const MOD_R = isMac ? "Meta+r" : "Control+r";

/**
 * Cmd+R used to reload the whole Geode renderer from inside a Web Viewer tab,
 * destroying every open pane and every unsaved buffer, because the stock
 * `{ role: "viewMenu" }` claimed the accelerator and nothing in the renderer
 * ever called preventDefault() on it.
 *
 * Two independent halves had to land for that to stop:
 *   1. the View menu no longer binds CmdOrCtrl+R at all, and
 *   2. Mod+R is a real Geode command (`web.reload`) that consumes the key
 *      wherever the action is available.
 *
 * Neither alone is sufficient. Availability gating differs between the host
 * document (preventDefault only when the command is available) and a
 * `<webview>` guest (main.ts's bridge is availability-blind and preventDefaults
 * every published combo), so on a markdown tab only half 1 protects the app.
 */

/** A throwaway vault per test, so tab counts never depend on a previous run. */
async function launch(files: Record<string, string> = {}) {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-web-reload-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-web-reload-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n\nBody text.\n");
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(vaultDir, name), body);
  }
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await expect(window.locator(".workspace")).toBeVisible();
  const cleanup = () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  return { app, window, vaultDir, cleanup };
}

/**
 * The address bar is written synchronously by `loadUrl()`, well before the
 * guest commits the navigation, so it is not a signal that the guest is on
 * the page yet. Wait for the guest WebContents itself.
 */
async function waitForGuestUrl(app: ElectronApplication, urlPart: string) {
  await expect
    .poll(() => app.evaluate(({ webContents }, part) =>
      webContents.getAllWebContents().some((wc) => wc.getType() === "webview" && wc.getURL().includes(part)),
    urlPart), { timeout: 20_000 })
    .toBe(true);
}

/**
 * Send a keystroke to a `<webview>` guest rather than the host page, the way
 * `webview-hotkeys.spec.ts` does. Unlike that helper this one selects the
 * guest by URL: these tests can have more than one guest alive, and picking
 * the first `webview` WebContents would silently target the wrong one.
 */
async function pressInGuest(app: ElectronApplication, key: string, modifiers: string[], urlPart: string) {
  return app.evaluate(({ webContents }, payload) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === "webview" && wc.getURL().includes(payload.urlPart));
    if (!guest) return false;
    guest.focus();
    guest.sendInputEvent({
      type: "keyDown",
      keyCode: payload.key,
      modifiers: payload.modifiers as ("meta" | "control" | "shift" | "alt")[],
    });
    return true;
  }, { key, modifiers, urlPart });
}

const rootTabs = (window: Page) =>
  window.locator(".workspace-split.mod-root .workspace-tab-header");

async function runCommand(window: Page, name: string) {
  await window.keyboard.press(isMac ? "Meta+P" : "Control+P");
  await window.locator(".prompt-input").fill(name);
  await window.getByText(name, { exact: true }).click();
}

/**
 * Run script inside the guest whose URL contains `urlPart`, selected in the
 * main process. Deliberately not an index into the `webview` elements: with
 * more than one guest alive, an index silently targets the wrong one.
 */
const guestEval = (app: ElectronApplication, urlPart: string, script: string) =>
  app.evaluate(({ webContents }, payload) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === "webview" && wc.getURL().includes(payload.urlPart));
    return guest ? guest.executeJavaScript(payload.script) : null;
  }, { urlPart, script });

/** Count calls to the active view's reload() without changing what it does. */
async function spyOnActiveViewReload(window: Page) {
  await window.evaluate(() => {
    const view = (window as unknown as { app: { workspace: { getActiveLeaf(): { view: Record<string, unknown> } } } })
      .app.workspace.getActiveLeaf().view;
    (window as unknown as { __reloads: number }).__reloads = 0;
    const original = (view.reload as () => void).bind(view);
    view.reload = () => {
      (window as unknown as { __reloads: number }).__reloads += 1;
      original();
    };
  });
}

const reloadCount = (window: Page) =>
  window.evaluate(() => (window as unknown as { __reloads: number }).__reloads);

/** Mark the guest's JS context; a real page reload throws the context away. */
const markGuest = (window: Page, selector: string) =>
  window.locator(selector).evaluate((guest) =>
    (guest as unknown as { executeJavaScript(s: string): Promise<unknown> })
      .executeJavaScript("window.__marker = 1; 'ok'"));

const guestMarker = (window: Page, selector: string) =>
  window.locator(selector).evaluate((guest) =>
    (guest as unknown as { executeJavaScript(s: string): Promise<unknown> })
      .executeJavaScript("typeof window.__marker"));

const PROBE_HTML = "<!doctype html><title>Reload probe</title><h1 id=\"probe\">probe</h1>\n";

test("Mod+R inside a web viewer guest reloads the page, not the whole app", async () => {
  const { app, window, vaultDir, cleanup } = await launch({ "page.html": PROBE_HTML });

  try {
    const url = pathToFileURL(path.join(vaultDir, "page.html")).href;
    await window.evaluate((target) => (window as unknown as { app: { openWebViewer(u: string): void } }).app.openWebViewer(target), url);
    await expect(window.locator(".web-view-frame")).toBeVisible();
    await waitForGuestUrl(app, "page.html");
    const tabsBefore = await rootTabs(window).count();

    // The host sentinel dies with a renderer reload; the guest marker dies
    // with a page reload. This one keystroke must kill exactly the second.
    await window.evaluate(() => { (window as unknown as { __sentinel: number }).__sentinel = 1; });
    expect(await markGuest(window, ".web-view-frame")).toBe("ok");

    expect(await pressInGuest(app, "r", [MOD], "page.html")).toBe(true);

    await expect.poll(() => guestMarker(window, ".web-view-frame"), { timeout: 15_000 }).toBe("undefined");
    // This is the reported bug. A guest's unhandled keystroke is handed to the
    // application menu, whose stock Reload wiped the renderer: every open pane
    // and every unsaved buffer, with no warning.
    expect(await window.evaluate(() => (window as unknown as { __sentinel?: number }).__sentinel)).toBe(1);
    await expect(rootTabs(window)).toHaveCount(tabsBefore);
    await expect(window.locator(".web-view-frame")).toBeVisible();
  } finally {
    await app.close();
    cleanup();
  }
});

/**
 * A markdown tab has no guest, so the only path to the menu is a real OS key
 * event on the host document. Playwright's synthetic keystrokes go in over
 * CDP and never reach a native menu accelerator, so this test cannot
 * reproduce the original bug and passes against pre-fix source too. It is
 * kept as a guard that Mod+R stays inert where no view can reload. The
 * menu-accelerator half of the fix is covered at the unit layer instead, by
 * tests/unit/application-menu.test.ts.
 */
test("Mod+R on a markdown tab leaves the renderer and its panes alone", async () => {
  const { app, window, cleanup } = await launch();

  try {
    await window.locator('.nav-file-title[data-path="Note.md"]').click();
    await expect(window.locator(".workspace-leaf.mod-active .markdown-source-view")).toBeVisible();
    const tabsBefore = await rootTabs(window).count();

    // A renderer reload wipes every global, so this sentinel is the definitive
    // proof: it can only survive if nothing reloaded the page.
    await window.evaluate(() => { (window as unknown as { __sentinel: number }).__sentinel = 1; });
    await window.keyboard.press(MOD_R);

    // Give a reload time to actually happen before asserting that it did not.
    await window.waitForTimeout(1500);
    expect(await window.evaluate(() => (window as unknown as { __sentinel?: number }).__sentinel)).toBe(1);
    await expect(rootTabs(window)).toHaveCount(tabsBefore);
    await expect(window.locator(".workspace-leaf.mod-active .markdown-source-view")).toBeVisible();
  } finally {
    await app.close();
    cleanup();
  }
});

test("Mod+R from the host document reloads the page in a web tab, not the app", async () => {
  const { app, window, vaultDir, cleanup } = await launch({ "page.html": PROBE_HTML });

  try {
    const url = pathToFileURL(path.join(vaultDir, "page.html")).href;
    await window.evaluate((target) => (window as unknown as { app: { openWebViewer(u: string): void } }).app.openWebViewer(target), url);
    await expect(window.locator(".web-view-frame")).toBeVisible();
    // Mark only once the guest is genuinely on the page: marking too early
    // would let the pending navigation, not the reload, clear the marker.
    await waitForGuestUrl(app, "page.html");
    expect(await markGuest(window, ".web-view-frame")).toBe("ok");
    await window.evaluate(() => { (window as unknown as { __sentinel: number }).__sentinel = 1; });

    // Focus the address bar so the keystroke is unambiguously a host-document
    // event, then type into it: a reload must discard uncommitted typing
    // rather than navigating to it.
    await window.locator(".web-view-address").click();
    await window.locator(".web-view-address").fill("this-was-never-committed");
    await window.keyboard.press(MOD_R);

    // The guest's JS context is gone, so the page really reloaded...
    await expect.poll(() => guestMarker(window, ".web-view-frame"), { timeout: 15_000 }).toBe("undefined");
    // ...the address bar snapped back to the loaded URL...
    await expect(window.locator(".web-view-address")).toHaveValue(/page\.html$/);
    // ...and the host renderer survived.
    expect(await window.evaluate(() => (window as unknown as { __sentinel?: number }).__sentinel)).toBe(1);

    // A reload is not a navigation: two of them must not push history entries.
    await window.keyboard.press(MOD_R);
    await expect(window.locator('.web-view-toolbar button[title="Back"]')).toHaveClass(/is-disabled/);
  } finally {
    await app.close();
    cleanup();
  }
});

test("Mod+R pressed inside a web viewer guest reloads that page exactly once", async () => {
  const { app, window, vaultDir, cleanup } = await launch({ "page.html": PROBE_HTML });

  try {
    const url = pathToFileURL(path.join(vaultDir, "page.html")).href;
    await window.evaluate((target) => (window as unknown as { app: { openWebViewer(u: string): void } }).app.openWebViewer(target), url);
    await expect(window.locator(".web-view-frame")).toBeVisible();
    await waitForGuestUrl(app, "page.html");
    await spyOnActiveViewReload(window);
    await window.evaluate(() => { (window as unknown as { __sentinel: number }).__sentinel = 1; });

    expect(await pressInGuest(app, "r", [MOD], "page.html")).toBe(true);

    await expect.poll(() => reloadCount(window), { timeout: 15_000 }).toBe(1);
    // One keystroke, one reload: the guest bridge must not double-dispatch,
    // and the host document must not also see the key.
    await window.waitForTimeout(1000);
    expect(await reloadCount(window)).toBe(1);
    expect(await window.evaluate(() => (window as unknown as { __sentinel?: number }).__sentinel)).toBe(1);
  } finally {
    await app.close();
    cleanup();
  }
});

test("Mod+R acts on the guest it was pressed in, not on the host's active tab", async () => {
  const { app, window, vaultDir, cleanup } = await launch({
    "one.html": PROBE_HTML,
    "two.html": PROBE_HTML,
  });

  try {
    const open = (name: string) =>
      window.evaluate(
        (target) => (window as unknown as { app: { openWebViewer(u: string): void } }).app.openWebViewer(target),
        pathToFileURL(path.join(vaultDir, name)).href,
      );
    // A split, because a tab group keeps only its active leaf's guest alive.
    // Two groups is also the layout where the misroute actually bites.
    await open("one.html");
    await waitForGuestUrl(app, "one.html");
    await runCommand(window, "Split right");
    // The second group's tab becomes the active leaf; the keystroke below
    // goes to the first group's guest instead.
    await open("two.html");
    await waitForGuestUrl(app, "two.html");
    await expect(window.locator(".web-view-frame")).toHaveCount(2);

    const mark = (part: string) => guestEval(app, part, "window.__marker = 1; 'ok'");
    const marker = (part: string) => guestEval(app, part, "typeof window.__marker");
    expect(await mark("one.html")).toBe("ok");
    expect(await mark("two.html")).toBe("ok");

    expect(await pressInGuest(app, "r", [MOD], "one.html")).toBe(true);

    // The pressed pane reloaded...
    await expect.poll(() => marker("one.html"), { timeout: 15_000 }).toBe("undefined");
    // ...and the merely-active one did not. A click inside a guest never
    // reaches the host as a DOM event, so the host's active leaf does not
    // follow focus into a webview: without the guest id the reload would have
    // landed on the pane the user was not looking at.
    await window.waitForTimeout(1000);
    expect(await marker("two.html")).toBe("number");
  } finally {
    await app.close();
    cleanup();
  }
});

test("web tab menus lead with Reload and share one Bookmark implementation", async () => {
  const { app, window, vaultDir, cleanup } = await launch({ "page.html": PROBE_HTML });

  try {
    const url = pathToFileURL(path.join(vaultDir, "page.html")).href;
    await window.evaluate((target) => (window as unknown as { app: { openWebViewer(u: string): void } }).app.openWebViewer(target), url);
    await expect(window.locator(".web-view-frame")).toBeVisible();

    // "More options" is composed from WEB_TAB_MENU_SPEC, so the toolbar menu
    // and the tab menu can no longer disagree about what a page action is.
    await window.locator('.web-view-toolbar button[title="More options"]').click();
    await expect(window.locator(".menu-item")).toHaveText(["Reload page", "Bookmark this page"]);
    await window.keyboard.press("Escape");
    await expect(window.locator(".menu-item")).toHaveCount(0);

    // Reload comes first in the tab menu: on a web tab the file sections all
    // collapse and the tab section always renders four items, so appending
    // would have buried it at the bottom.
    await window.locator(".workspace-split.mod-root .workspace-tab-header.is-active").click({ button: "right" });
    await expect(window.locator(".menu-item")).toHaveText([
      "Reload page", "Pin", "Close", "Close others", "Close tabs to the right",
    ]);
  } finally {
    await app.close();
    cleanup();
  }
});

test("an artifact tab reloads from its toolbar button and from Mod+R", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "geode-artifact-reload-e2e-"));
  const userDataDir = path.join(temp, "user-data");
  const artifactRoot = path.join(temp, "artifact");
  const vaultPath = path.join(temp, "vault");
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(artifactRoot);
  fs.mkdirSync(vaultPath);
  fs.writeFileSync(path.join(vaultPath, "Welcome.md"), "# Welcome\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({
    recentVaults: [vaultPath], lastVault: vaultPath,
  }));
  const manifest = {
    schemaVersion: 1,
    id: "reload-proof",
    title: "Reload proof",
    entry: "index.html",
    runtime: "static",
    createdByThreadId: "thread-reload",
    viewport: { preset: "custom", width: 640, height: 400 },
    permissions: { network: "none", clipboard: false },
  };
  fs.writeFileSync(path.join(artifactRoot, "index.html"), "<!doctype html><h1>artifact</h1>");

  // Start from a manifest that fails validation, so load() bails and leaves
  // `webview` null — exactly the state in which the user reaches for Reload.
  fs.writeFileSync(path.join(artifactRoot, "artifact.json"), JSON.stringify({ schemaVersion: 1 }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.evaluate((root) => (window as unknown as { app: { openArtifact(r: string): void } }).app.openArtifact(root), artifactRoot);
    await expect(window.locator(".artifact-view-error")).toBeVisible();
    await expect(window.locator(".artifact-view-frame")).toHaveCount(0);

    // Reload with a null webview must re-run load(), not silently do nothing.
    fs.writeFileSync(path.join(artifactRoot, "artifact.json"), JSON.stringify(manifest));
    await window.getByRole("button", { name: "Reload artifact" }).click();
    const frame = window.locator(".artifact-view-frame");
    await expect(frame).toBeVisible({ timeout: 15_000 });
    await expect(frame).toHaveAttribute("src", "geode-artifact://reload-proof/index.html");

    // Toolbar button reloads the live guest.
    await expect.poll(() => guestMarker(window, ".artifact-view-frame"), { timeout: 15_000 }).toBe("undefined");
    expect(await markGuest(window, ".artifact-view-frame")).toBe("ok");
    await window.getByRole("button", { name: "Reload artifact" }).click();
    await expect.poll(() => guestMarker(window, ".artifact-view-frame"), { timeout: 15_000 }).toBe("undefined");

    // ...and so does Mod+R, through the same action.
    expect(await markGuest(window, ".artifact-view-frame")).toBe("ok");
    await window.evaluate(() => { (window as unknown as { __sentinel: number }).__sentinel = 1; });
    await window.keyboard.press(MOD_R);
    await expect.poll(() => guestMarker(window, ".artifact-view-frame"), { timeout: 15_000 }).toBe("undefined");
    expect(await window.evaluate(() => (window as unknown as { __sentinel?: number }).__sentinel)).toBe(1);

    // The action's dynamic label follows the view: "Reload artifact" here,
    // "Reload page" on a web tab. Bookmark is web-only, so it is absent.
    await window.locator(".workspace-split.mod-root .workspace-tab-header.is-active").click({ button: "right" });
    await expect(window.locator(".menu-item")).toHaveText([
      "Reload artifact", "Pin", "Close", "Close others", "Close tabs to the right",
    ]);
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
