import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function createVault() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-popup-menu-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-popup-menu-ud-"));
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    fs.writeFileSync(path.join(vaultDir, `${name}.md`), `# ${name}\n`);
  }
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );
  return { vaultDir, userDataDir };
}

test("All tabs uses the shared menu renderer and activates a selected tab", async () => {
  const { vaultDir, userDataDir } = createVault();
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    await window.evaluate(async () => {
      const geode = (window as any).app;
      for (const name of ["Alpha", "Beta", "Gamma"]) {
        await geode.openFile(geode.vault.getFileByPath(`${name}.md`), true);
      }
    });

    await window.locator(".workspace-split.mod-root .workspace-tab-header-tab-list .clickable-icon").click();
    const menu = window.locator("body > .menu.mod-tab-list");
    await expect(menu).toBeVisible();
    await expect(menu.locator(":scope > .menu-grabber")).toHaveCount(1);
    // Count only the tab entries (their own "tabs" section) — the Bookmarks
    // plugin adds a "Bookmark N tabs" item in a separate "bookmark" section.
    await expect(
      menu.locator(':scope > .menu-scroll > .menu-group > .menu-item.tappable[data-section="tabs"]')
    ).toHaveCount(4);
    // The Bookmarks entry point is present in its own section.
    await expect(
      menu.locator('.menu-item[data-section="bookmark"]').filter({ hasText: /Bookmark \d+ tabs?/ })
    ).toHaveCount(1);
    await expect(menu.locator(".menu-item.mod-checked .menu-item-icon.mod-checked")).toHaveCount(1);

    await menu.locator(".menu-item", { hasText: "Alpha" }).click();
    await expect(menu).toHaveCount(0);
    await expect(window.locator(".workspace-split.mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-title")).toHaveText("Alpha");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("All tabs menu chooses a non-overlapping orientation around every viewport edge", async () => {
  const { vaultDir, userDataDir } = createVault();
  const screenshotDir = process.env.POPUP_MENU_SCREENSHOT_DIR;
  const screenshotTheme = process.env.POPUP_MENU_SCREENSHOT_THEME;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    await window.evaluate(async () => {
      const geode = (window as any).app;
      for (const name of ["Alpha", "Beta", "Gamma"]) {
        await geode.openFile(geode.vault.getFileByPath(`${name}.md`), true);
      }
    });
    if (screenshotTheme === "light" || screenshotTheme === "dark") {
      await window.evaluate((theme) => {
        const geode = (window as any).app;
        geode.settings.theme = theme;
        geode.applySettings();
      }, screenshotTheme);
    }

    const trigger = window.locator(".workspace-split.mod-root .workspace-tab-header-tab-list .clickable-icon");
    const menu = window.locator("body > .menu.mod-tab-list");
    const orientations = [
      { name: "top-left", horizontal: "right", vertical: "below", left: 0, top: 0 },
      { name: "top", horizontal: "either", vertical: "below", left: "center", top: 0 },
      { name: "top-right", horizontal: "left", vertical: "below", left: "right", top: 0 },
      { name: "left", horizontal: "right", vertical: "below", left: 0, top: "center" },
      { name: "right", horizontal: "left", vertical: "below", left: "right", top: "center" },
      { name: "bottom-left", horizontal: "right", vertical: "above", left: 0, top: "bottom" },
      { name: "bottom", horizontal: "either", vertical: "above", left: "center", top: "bottom" },
      { name: "bottom-right", horizontal: "left", vertical: "above", left: "right", top: "bottom" },
    ] as const;

    for (const orientation of orientations) {
      await trigger.evaluate((element, placement) => {
        const size = 24;
        const resolveAxis = (value: number | "center" | "right" | "bottom", extent: number) => {
          if (value === "center") return Math.round((extent - size) / 2);
          if (value === "right" || value === "bottom") return extent - size;
          return value;
        };
        const htmlElement = element as HTMLElement;
        Object.assign(htmlElement.style, {
          position: "fixed",
          left: `${resolveAxis(placement.left, innerWidth)}px`,
          top: `${resolveAxis(placement.top, innerHeight)}px`,
          margin: "0",
          transform: "none",
          width: `${size}px`,
          height: `${size}px`,
          zIndex: "1000",
        });
      }, orientation);

      await trigger.click();
      await expect(menu, orientation.name).toBeVisible();
      const geometry = await window.evaluate(() => {
        const triggerElement = document.querySelector(
          ".workspace-split.mod-root .workspace-tab-header-tab-list .clickable-icon"
        )!;
        const menuElement = document.querySelector("body > .menu.mod-tab-list")!;
        const anchor = triggerElement.getBoundingClientRect();
        const popup = menuElement.getBoundingClientRect();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          anchor: { left: anchor.left, top: anchor.top, right: anchor.right, bottom: anchor.bottom },
          popup: { left: popup.left, top: popup.top, right: popup.right, bottom: popup.bottom },
        };
      });

      const viewportMargin = 6;
      expect(geometry.popup.left, `${orientation.name}: left viewport margin`).toBeGreaterThanOrEqual(viewportMargin);
      expect(geometry.popup.top, `${orientation.name}: top viewport margin`).toBeGreaterThanOrEqual(viewportMargin);
      expect(geometry.popup.right, `${orientation.name}: right viewport margin`).toBeLessThanOrEqual(
        geometry.viewport.width - viewportMargin
      );
      expect(geometry.popup.bottom, `${orientation.name}: bottom viewport margin`).toBeLessThanOrEqual(
        geometry.viewport.height - viewportMargin
      );

      if (orientation.vertical === "below") {
        expect(geometry.popup.top, `${orientation.name}: opens below without overlap`).toBeGreaterThanOrEqual(
          geometry.anchor.bottom
        );
        expect(geometry.popup.top - geometry.anchor.bottom, `${orientation.name}: stays anchored vertically`).toBeLessThanOrEqual(12);
      } else {
        expect(geometry.popup.bottom, `${orientation.name}: opens above without overlap`).toBeLessThanOrEqual(
          geometry.anchor.top
        );
        expect(geometry.anchor.top - geometry.popup.bottom, `${orientation.name}: stays anchored vertically`).toBeLessThanOrEqual(12);
      }

      if (orientation.horizontal === "right") {
        expect(geometry.popup.left, `${orientation.name}: opens rightward`).toBeGreaterThanOrEqual(
          geometry.anchor.left
        );
        expect(geometry.popup.left - geometry.anchor.left, `${orientation.name}: start-aligns with trigger`).toBeLessThanOrEqual(12);
      } else if (orientation.horizontal === "left") {
        expect(geometry.popup.right, `${orientation.name}: opens leftward`).toBeLessThanOrEqual(
          geometry.anchor.right
        );
        expect(geometry.anchor.right - geometry.popup.right, `${orientation.name}: end-aligns with trigger`).toBeLessThanOrEqual(12);
      }

      if (screenshotDir) {
        await window.screenshot({ path: path.join(screenshotDir, `${screenshotTheme ?? "default"}-${orientation.name}.png`) });
      }

      await window.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("plugin Menu exposes Obsidian DOM, states, sections, keyboard controls, and lifecycle", async () => {
  const { vaultDir, userDataDir } = createVault();
  const pluginDir = path.join(vaultDir, ".geode", "plugins", "popup-menu-probe");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(pluginDir + "/manifest.json", JSON.stringify({
    id: "popup-menu-probe",
    name: "Popup Menu Probe",
    version: "1.0.0",
    minAppVersion: "0.1.0",
    description: "Exercises the Obsidian-compatible Menu API.",
    author: "geode",
  }));
  fs.writeFileSync(pluginDir + "/main.js", `
    const { Menu, Plugin } = require('obsidian');
    module.exports.default = class extends Plugin {
      onload() {
        const menu = new Menu();
        menu.addItem(i => i.setTitle('First').setIcon('file').setSection('files').onClick(() => document.body.dataset.menuAction = 'first'));
        menu.addItem(i => i.setTitle('Disabled').setDisabled(true).setSection('files').onClick(() => document.body.dataset.menuAction = 'disabled'));
        menu.addSeparator();
        menu.addItem(i => i.setTitle(document.createRange().createContextualFragment('<strong>Label</strong>')).setIsLabel(true).setSection('meta'));
        menu.addItem(i => i.setTitle('Checked').setChecked(true).setSection('meta').onClick(() => document.body.dataset.menuAction = 'checked'));
        menu.onHide(() => document.body.dataset.menuHidden = 'yes');
        window.menuProbe = menu;
        menu.showAtPosition({ x: 100, y: 100 }, document);
      }
    };
  `);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["popup-menu-probe"]));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    const loadError = await window.evaluate(
      () => (window as any).app.pluginManager.getLoadError("popup-menu-probe") ?? null
    );
    expect(loadError).toBeNull();
    const menu = window.locator("body > .menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(":scope > .menu-grabber")).toHaveCount(1);
    await expect(menu.locator(":scope > .menu-scroll > .menu-group")).toHaveCount(2);
    await expect(menu.locator(".menu-item[data-section=files]")).toHaveCount(2);
    await expect(menu.locator(".menu-item.is-disabled")).toHaveText("Disabled");
    await expect(menu.locator(".menu-item.is-label strong")).toHaveText("Label");
    await expect(menu.locator(".menu-item.mod-checked > .menu-item-icon.mod-checked")).toHaveCount(1);

    const initialBox = await menu.boundingBox();
    expect(initialBox?.x).toBe(100);
    expect(initialBox?.y).toBe(100);

    const box = await window.evaluate(() => {
      const menu = (window as any).menuProbe;
      menu.showAtPosition({ x: innerWidth - 1, y: innerHeight - 1 }, document);
      const rect = menu.dom.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.width);
    expect(box.bottom).toBeLessThanOrEqual(box.height);
    expect(box.width - 1 - box.right).toBeLessThanOrEqual(8);
    expect(box.height - 1 - box.bottom).toBeLessThanOrEqual(8);

    await menu.locator(".menu-item.is-disabled").click();
    await expect(menu).toBeVisible();
    expect(await window.evaluate(() => document.body.dataset.menuAction)).toBeUndefined();

    await window.keyboard.press("Home");
    await expect(menu.locator(".menu-item.selected")).toHaveText("First");
    await window.keyboard.press("ArrowDown");
    await expect(menu.locator(".menu-item.selected")).toHaveText("Checked");
    await window.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    expect(await window.evaluate(() => document.body.dataset.menuAction)).toBe("checked");
    expect(await window.evaluate(() => document.body.dataset.menuHidden)).toBe("yes");

    await window.evaluate(() => {
      const focusTarget = document.createElement("button");
      focusTarget.id = "menu-focus-target";
      document.body.appendChild(focusTarget);
      focusTarget.focus();
      (window as any).menuProbe.showAtPosition({ x: 100, y: 100 }, document);
    });
    await window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    expect(await window.evaluate(() => document.activeElement?.id)).toBe("menu-focus-target");

    await window.evaluate(() => (window as any).menuProbe.showAtPosition({ x: 100, y: 100 }, document));
    await window.mouse.click(10, 10);
    await expect(menu).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
