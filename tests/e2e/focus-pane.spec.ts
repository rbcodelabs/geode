import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * Focus pane: one center tab group temporarily takes over the window.
 * Non-destructive — hidden panes/sidebars keep their DOM, sizes and collapsed
 * state, so exiting restores the identical layout.
 */

let app: ElectronApplication;
let window: Page;

test.beforeEach(async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-focus-pane-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-focus-pane-ud-"));
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  app = await electron.launch({ args: [path.resolve("."), `--user-data-dir=${userData}`], cwd: path.resolve(".") });
  window = await app.firstWindow();
  await window.waitForSelector(".workspace");
  const browserWindow = await app.browserWindow(window);
  await browserWindow.evaluate((win: any) => win.setSize(1280, 900));
});

test.afterEach(async () => { await app?.close(); });

async function openSecondGroup(): Promise<void> {
  await window.evaluate(async () => {
    const a = (window as any).app;
    const file = a.vault.getFileByPath("one.md") ?? (await a.vault.create("one.md", "# one"));
    await a.openFile(file, false);
    a.workspace.addGroup(a.workspace.groups[0]);
    const g2 = a.workspace.groups[1];
    const f2 = a.vault.getFileByPath("two.md") ?? (await a.vault.create("two.md", "# two"));
    a.workspace.setActiveGroup(g2);
    await a.openFile(f2, false);
  });
  await expect(window.locator(".workspace-center .workspace-tabs")).toHaveCount(2);
}

/** Geometry + state that must be bit-identical across a focus round trip. */
async function snapshot() {
  return window.evaluate(() => {
    const ws = (window as any).app.workspace;
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); };
    return {
      left: rect(ws.leftSidebar.containerEl),
      right: rect(ws.rightSidebar.containerEl),
      groups: ws.groups.map((g: any) => rect(g.containerEl)),
      collapsed: [ws.leftSidebar.collapsed, ws.rightSidebar.collapsed],
      rootClass: ws.rootEl.className.replace(/\s*is-focus-pane/, ""),
      layout: JSON.stringify(ws.serialize()),
    };
  });
}

const visible = (selector: string) => window.evaluate((s) => {
  const el = document.querySelector(s) as HTMLElement | null;
  return !!el && el.getClientRects().length > 0;
}, selector);

test("focus hides sidebars and other panes; exit restores the identical layout", async () => {
  await openSecondGroup();
  // Non-default sidebar width so restore is meaningfully checked.
  await window.evaluate(() => { (window as any).app.workspace.leftSidebar.containerEl.style.width = "333px"; });
  await window.waitForTimeout(400);
  const before = await snapshot();
  expect(before.groups).toHaveLength(2);

  await window.evaluate(() => (window as any).app.commands.executeCommandById("workspace:toggle-focus-pane"));
  await expect(window.locator(".workspace.is-focus-pane")).toHaveCount(1);
  expect(await visible(".workspace-sidebar.mod-left")).toBe(false);
  expect(await visible(".workspace-sidebar.mod-right")).toBe(false);
  await expect(window.locator(".workspace-center .workspace-tabs:visible")).toHaveCount(1);
  await expect(window.locator(".workspace-tabs.is-focused-pane .focus-pane-exit-button")).toBeVisible();
  const focused = await window.evaluate(() => {
    const ws = (window as any).app.workspace;
    const r = ws.focusedGroup.containerEl.getBoundingClientRect();
    return { isActive: ws.focusedGroup === ws.activeGroup, width: r.width, window: document.querySelector(".workspace")!.getBoundingClientRect().width };
  });
  expect(focused.isActive).toBe(true);
  expect(focused.width).toBeGreaterThan(focused.window - 2);
  // Normal layout is what gets persisted.
  expect((await snapshot()).layout).toBe(before.layout);

  await window.locator(".workspace-tabs.is-focused-pane .focus-pane-exit-button").click();
  await expect(window.locator(".workspace.is-focus-pane")).toHaveCount(0);
  await window.waitForTimeout(400);
  expect(await snapshot()).toEqual(before);
  expect(await window.evaluate(() => (window as any).app.workspace.leftSidebar.containerEl.style.width)).toBe("333px");
});

test("collapsed sidebar state is preserved; tab menu item toggles; sidebar toggle exits focus", async () => {
  await openSecondGroup();
  await window.evaluate(() => (window as any).app.workspace.rightSidebar.collapse());
  await window.waitForTimeout(400);
  const before = await snapshot();
  expect(before.collapsed).toEqual([false, true]);

  // Context menu on the tab header.
  await window.locator(".workspace-tab-header", { hasText: "two" }).click({ button: "right" });
  await window.locator(".menu-item", { hasText: "Focus this pane" }).click();
  await expect(window.locator(".workspace.is-focus-pane")).toHaveCount(1);
  await window.locator(".workspace-tab-header", { hasText: "two" }).click({ button: "right" });
  await expect(window.locator(".menu-item", { hasText: "Exit focus" })).toBeVisible();
  await window.keyboard.press("Escape");

  // Toggling a sidebar while focused ends focus and leaves sidebar state alone.
  await window.evaluate(() => (window as any).app.commands.executeCommandById("toggle-left-sidebar"));
  await expect(window.locator(".workspace.is-focus-pane")).toHaveCount(0);
  await window.waitForTimeout(400);
  expect(await snapshot()).toEqual(before);
});

test("closing the focused group, or revealing a hidden leaf, ends focus", async () => {
  await openSecondGroup();
  await window.evaluate(() => (window as any).app.workspace.toggleFocusPane());
  await expect(window.locator(".workspace.is-focus-pane")).toHaveCount(1);
  await window.evaluate(async () => {
    const ws = (window as any).app.workspace;
    for (const leaf of [...ws.focusedGroup.leaves]) await leaf.detach();
  });
  await expect(window.locator(".workspace.is-focus-pane")).toHaveCount(0);
  expect(await window.evaluate(() => (window as any).app.workspace.focusedGroup)).toBeNull();
  await expect(window.locator(".workspace-center .workspace-tabs")).toHaveCount(1);
  await expect(window.locator(".workspace-center .workspace-tabs.is-focused-pane")).toHaveCount(0);
  expect(await visible(".workspace-sidebar.mod-left")).toBe(true);

  // Revealing a sidebar-docked leaf exits focus.
  await window.evaluate(() => (window as any).app.workspace.toggleFocusPane());
  await expect(window.locator(".workspace.is-focus-pane")).toHaveCount(1);
  await window.evaluate(() => {
    const ws = (window as any).app.workspace;
    ws.revealLeaf(ws.getLeavesOfType("file-explorer")[0]);
  });
  await expect(window.locator(".workspace.is-focus-pane")).toHaveCount(0);
});
