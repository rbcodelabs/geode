import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function fixture() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-collections-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-collections-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Alpha.md"), "# Alpha\n");
  fs.writeFileSync(path.join(vaultDir, "Beta.md"), "# Beta\n");
  fs.writeFileSync(path.join(vaultDir, "Gamma.md"), "# Gamma\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  return { vaultDir, userDataDir };
}

test("creates, edits, collapses, activates, and restores a named tab collection", async ({}, testInfo) => {
  const { vaultDir, userDataDir } = fixture();
  let app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    let window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    const browserWindow = await app.browserWindow(window);
    await browserWindow.evaluate((nativeWindow: any) => nativeWindow.setSize(900, 700));
    await window.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("Alpha.md"), true);
      await a.openFile(a.vault.getFileByPath("Beta.md"), true);
    });

    const alpha = window.locator('.workspace-tab-header[data-type="markdown"]', { hasText: "Alpha" });
    await alpha.click({ button: "right" });
    await window.locator(".menu-item", { hasText: "Add tab to new collection" }).click();
    const rename = window.locator(".tab-collection-rename");
    await expect(rename).toBeFocused();
    await rename.fill("Research");
    await rename.press("Enter");
    const initialSurface = window.locator(".tab-collection-surface");
    await initialSurface.dblclick();
    await expect(window.locator(".tab-collection-rename")).toBeFocused();
    await window.locator(".tab-collection-rename").press("Escape");

    const beta = window.locator('.workspace-tab-header[data-type="markdown"]', { hasText: "Beta" });
    await beta.click({ button: "right" });
    await window.locator(".menu-item", { hasText: "Add tab to collection" }).click();
    await window.locator(".menu-item", { hasText: "Research" }).click();

    const label = window.locator(".tab-collection-label");
    await expect(label).toHaveAttribute("data-color", "gray");
    await label.click({ button: "right" });
    await window.locator(".menu-item", { hasText: "Collection color" }).click();
    await window.locator(".menu-item", { hasText: "purple" }).click();
    await expect(label).toHaveAttribute("data-color", "purple");
    await expect(label.getByText("2", { exact: true })).toBeVisible();
    const disclosure = label.locator(".tab-collection-disclosure");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(alpha).toBeHidden();
    await expect(beta).toBeHidden();
    await disclosure.focus();
    await disclosure.press("ArrowLeft");
    await expect(label.locator("..").locator(".workspace-tab-header:not([hidden])").first()).toBeFocused();
    await label.locator(".tab-collection-surface").focus();
    await label.locator(".tab-collection-surface").press("Enter");
    await expect(label.locator(".tab-collection-surface")).toBeFocused();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await disclosure.focus();
    await disclosure.press("Space");
    await expect(disclosure).toBeFocused();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await disclosure.press("Space");
    await expect(disclosure).toBeFocused();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");

    const isMac = process.platform === "darwin";
    await window.keyboard.press(isMac ? "Meta+P" : "Control+P");
    await window.locator(".prompt-input").fill("Toggle active tab's collection collapsed");
    await window.getByText("Tabs: Toggle active tab's collection collapsed").click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await disclosure.click();

    await window.locator(".workspace-tab-header-tab-list .clickable-icon").first().click();
    await window.locator(".menu-item", { hasText: "Research" }).click();
    await window.locator(".menu-item", { hasText: "Beta" }).click();
    await expect(label).toHaveClass(/is-active/);
    await expect(label.locator(".tab-collection-surface")).toHaveAttribute("aria-label", /collapsed, 2 tabs, active: Beta/);
    await expect(window.locator(".workspace-tab-container")).toContainText("Beta");
    for (const size of [
      { name: "small", width: 900, height: 700 },
      { name: "standard", width: 1280, height: 800 },
    ]) {
      await browserWindow.evaluate((nativeWindow: any, nextSize) => nativeWindow.setSize(nextSize.width, nextSize.height), size);
      await expect.poll(() => window.evaluate(() => window.innerWidth)).toBeGreaterThan(size.width - 100);
      for (const scheme of ["light", "dark"] as const) {
        await window.evaluate((value) => {
          const a = (window as any).app; a.settings.theme = value; a.applySettings();
        }, scheme);
        await label.locator(".tab-collection-surface").focus();
        await window.keyboard.press("Shift+Tab");
        await expect(disclosure).toBeFocused();
        await expect(label).toHaveClass(/is-active/);
        await expect.poll(() => disclosure.evaluate((element) => getComputedStyle(element).backgroundColor))
          .not.toBe("rgba(0, 0, 0, 0)");
        const treatment = await disclosure.evaluate((element) => {
          const style = getComputedStyle(element);
          const labelStyle = getComputedStyle(element.closest<HTMLElement>(".tab-collection-label")!);
          const channels = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
          const luminance = (value: string) => {
            const [r, g, b] = channels(value).map((channel) => {
              const normalized = channel / 255;
              return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const foreground = luminance(style.color);
          const background = luminance(style.backgroundColor);
          return {
            focusVisible: element.matches(":focus-visible"),
            outlineWidth: style.outlineWidth,
            outlineStyle: style.outlineStyle,
            backgroundColor: style.backgroundColor,
            boxShadow: style.boxShadow,
            labelBoxShadow: labelStyle.boxShadow,
            contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
          };
        });
        expect(treatment.focusVisible).toBe(true);
        expect(treatment.outlineStyle).toBe("none");
        expect(treatment.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
        expect(treatment.boxShadow).toContain("inset");
        expect(treatment.labelBoxShadow).not.toBe("none");
        expect(treatment.contrast).toBeGreaterThanOrEqual(3);
        const screenshot = testInfo.outputPath(`tab-collections-active-focus-${size.name}-${scheme}.png`);
        await window.screenshot({ path: screenshot, animations: "disabled" });
        await testInfo.attach(`tab-collections-active-focus-${size.name}-${scheme}`, { path: screenshot, contentType: "image/png" });
      }
    }
    await window.evaluate(() => {
      const group = (window as any).app.workspace.activeGroup;
      const alphaLeaf = group.leaves.find((leaf: any) => leaf.view?.getFile?.()?.path === "Alpha.md");
      group.setActiveLeaf(alphaLeaf);
    });
    await expect(label.locator(".tab-collection-surface")).toHaveAttribute("aria-label", /active: Alpha/);

    await expect.poll(() => {
      const file = path.join(vaultDir, ".geode", "workspace.json");
      if (!fs.existsSync(file)) return null;
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      return state.version === 3
        && state.center.root.collections?.[0]?.collapsed === true
        && state.center.root.active === 0
        ? state
        : null;
    }, { timeout: 5000 }).not.toBeNull();
    await app.close();

    app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
    window = await app.firstWindow();
    const restored = window.locator(".tab-collection-label");
    await expect(restored).toHaveClass(/is-collapsed/);
    await expect(restored).toHaveClass(/is-active/);
    await expect(restored.locator(".tab-collection-surface")).toHaveAttribute("aria-label", /active: Alpha/);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("normalizes v3 and prunes missing members with next-survivor active fallback", async () => {
  const { vaultDir, userDataDir } = fixture();
  fs.mkdirSync(path.join(vaultDir, ".geode"), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, ".geode", "workspace.json"), JSON.stringify({
    version: 3,
    center: { activeGroup: 0, root: { type: "tabs", active: 1,
      collections: [{ id: "c", name: "Research", color: "purple", collapsed: true }],
      leaves: [
        { type: "markdown", file: "Alpha.md", collectionId: "c" },
        { type: "markdown", file: "Missing.md", collectionId: "c" },
        { type: "markdown", file: "Beta.md", collectionId: "c" },
        { type: "markdown", file: "Gamma.md" },
      ] } },
    left: { root: null }, right: { root: null },
  }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".tab-collection-label")).toHaveClass(/is-active/);
    await expect(window.locator(".tab-collection-surface")).toHaveAttribute("aria-label", /2 tabs, active: Beta/);
    expect(await window.evaluate(() => (window as any).app.workspace.serialize().center.root.leaves
      .map((leaf: any) => leaf.file))).toEqual(["Alpha.md", "Beta.md", "Gamma.md"]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("restores pane sizes with independent split-local collections and the active center leaf", async ({}, testInfo) => {
  const { vaultDir, userDataDir } = fixture();
  fs.mkdirSync(path.join(vaultDir, ".geode"), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, ".geode", "workspace.json"), JSON.stringify({
    version: 3,
    center: { activeGroup: 1, root: { type: "split", direction: "horizontal", sizes: [0.3, 0.7], children: [
      { type: "tabs", active: 0,
        collections: [{ id: "left", name: "Left work", color: "blue", collapsed: false }],
        leaves: [{ type: "markdown", file: "Alpha.md", collectionId: "left" }] },
      { type: "tabs", active: 0,
        collections: [{ id: "right", name: "Right work", color: "purple", collapsed: true }],
        leaves: [{ type: "markdown", file: "Beta.md", collectionId: "right" }] },
    ] } },
    left: { collapsed: true, root: { type: "tabs", active: 0, collections: [{ id: "bad", name: "Sidebar", color: "red", collapsed: true }],
      leaves: [{ type: "file-explorer", collectionId: "bad" }] } },
    right: { collapsed: true, root: null },
  }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace-center > .workspace-tabs")).toHaveCount(2);
    await expect(window.locator(".workspace-center > .workspace-center-resize-handle")).toHaveCount(1);
    await expect(window.locator(".workspace-center .tab-collection-label")).toHaveCount(2);
    await expect(window.locator(".sidebar-tab-group .tab-collection-label")).toHaveCount(0);
    const state = await window.evaluate(() => {
      const workspace = (window as any).app.workspace;
      return {
        activeGroup: workspace.groups.indexOf(workspace.activeGroup),
        activeFile: workspace.activeLeaf?.view?.getFile?.()?.path,
        state: workspace.serialize(),
      };
    });
    expect(state.activeGroup).toBe(1);
    expect(state.activeFile).toBe("Beta.md");
    expect(state.state.version).toBe(3);
    expect(state.state.center.root.sizes).toEqual([0.3, 0.7]);
    expect(state.state.center.root.children.map((child: any) => child.collections[0].name))
      .toEqual(["Left work", "Right work"]);
    expect(state.state.left.root.collections).toBeUndefined();
    expect(state.state.left.root.leaves[0].collectionId).toBeUndefined();
    const browserWindow = await app.browserWindow(window);
    const activeLabel = window.locator(".workspace-center .tab-collection-label").nth(1);
    const disclosure = activeLabel.locator(".tab-collection-disclosure");
    for (const size of [
      { name: "small", width: 900, height: 700 },
      { name: "standard", width: 1280, height: 800 },
      { name: "large", width: 1440, height: 900 },
    ]) {
      await browserWindow.evaluate((nativeWindow: any, nextSize) => nativeWindow.setSize(nextSize.width, nextSize.height), size);
      await expect.poll(() => window.evaluate(() => window.innerWidth)).toBeGreaterThan(size.width - 100);
      for (const scheme of ["light", "dark"] as const) {
        await window.evaluate((value) => {
          const a = (window as any).app; a.settings.theme = value; a.applySettings();
        }, scheme);
        await activeLabel.locator(".tab-collection-surface").focus();
        await window.keyboard.press("Shift+Tab");
        await expect(disclosure).toBeFocused();
        await expect(activeLabel).toHaveClass(/is-active/);
        const screenshot = testInfo.outputPath(`tab-collections-center-panes-${size.name}-${scheme}.png`);
        await window.screenshot({ path: screenshot, animations: "disabled" });
        await testInfo.attach(`tab-collections-center-panes-${size.name}-${scheme}`, { path: screenshot, contentType: "image/png" });
      }
    }
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("keeps collection controls usable under light/dark and two structural community theme fixtures", async ({}, testInfo) => {
  const { vaultDir, userDataDir } = fixture();
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    const browserWindow = await app.browserWindow(window);
    await browserWindow.evaluate((nativeWindow: any) => nativeWindow.setSize(1280, 800));
    await window.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("Alpha.md"), true);
      a.workspace.activeGroup.createCollection(a.workspace.activeGroup.active);
    });
    await window.locator(".tab-collection-rename").press("Enter");
    const label = window.locator(".tab-collection-label");
    const disclosure = label.locator(".tab-collection-disclosure");
    for (const scheme of ["light", "dark"]) {
      await window.evaluate((value) => {
        const a = (window as any).app; a.settings.theme = value; a.applySettings();
      }, scheme);
      await expect(label).toBeVisible();
      expect((await disclosure.boundingBox())!.width).toBeGreaterThanOrEqual(28);
      const screenshot = testInfo.outputPath(`tab-collections-default-${scheme}.png`);
      await window.screenshot({ path: screenshot, animations: "disabled" });
      await testInfo.attach(`tab-collections-default-${scheme}`, { path: screenshot, contentType: "image/png" });
    }
    for (const name of ["TallSquare", "CompactRounded"]) {
      const css = fs.readFileSync(path.join(repoRoot, "tests", "fixtures", "themes", name, "theme.css"), "utf8");
      await window.evaluate(({ name, css }) => {
        document.querySelector("#collection-theme-fixture")?.remove();
        const style = document.createElement("style"); style.id = "collection-theme-fixture"; style.dataset.name = name; style.textContent = css;
        document.head.appendChild(style);
      }, { name, css });
      await expect(label).toBeVisible();
      const geometry = await label.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const surface = element.querySelector<HTMLElement>(".tab-collection-surface")!;
        return { width: rect.width, height: rect.height, overflow: getComputedStyle(surface).overflow };
      });
      expect(geometry.width).toBeGreaterThan(70);
      expect(geometry.height).toBeGreaterThanOrEqual(28);
      await disclosure.focus();
      await expect(disclosure).toBeFocused();
      const screenshot = testInfo.outputPath(`tab-collections-${name}.png`);
      await window.screenshot({ path: screenshot, animations: "disabled" });
      await testInfo.attach(`tab-collections-${name}`, { path: screenshot, contentType: "image/png" });
    }
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("keeps pinning orthogonal and clears membership when a tab moves across splits", async () => {
  const { vaultDir, userDataDir } = fixture();
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    const browserWindow = await app.browserWindow(window);
    await browserWindow.evaluate((nativeWindow: any) => nativeWindow.setSize(900, 700));
    const result = await window.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getFileByPath("Alpha.md"), true);
      await a.openFile(a.vault.getFileByPath("Beta.md"), true);
      const source = a.workspace.activeGroup;
      const alpha = source.leaves.find((leaf: any) => leaf.view?.getFile?.()?.path === "Alpha.md");
      const beta = source.leaves.find((leaf: any) => leaf.view?.getFile?.()?.path === "Beta.md");
      const collection = source.createCollection(alpha);
      source.addLeafToCollection(beta, collection.id);
      beta.setPinned(true);
      const destination = a.workspace.addGroup(source);
      a.workspace.moveLeaf(beta, destination);
      const state = a.workspace.serialize();
      return {
        destinationMembership: beta.collectionId,
        destinationPinned: beta.pinned,
        sourceCollections: source.collections,
        persistedDestination: state.center.root.children[1].leaves[0],
      };
    });
    expect(result.destinationMembership).toBeUndefined();
    expect(result.destinationPinned).toBe(true);
    expect(result.sourceCollections).toHaveLength(1);
    expect(result.persistedDestination).toMatchObject({ file: "Beta.md", pinned: true });
    expect(result.persistedDestination.collectionId).toBeUndefined();
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("drags a whole collection block without splitting its member run", async () => {
  const { vaultDir, userDataDir } = fixture();
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    const browserWindow = await app.browserWindow(window);
    await browserWindow.evaluate((nativeWindow: any) => nativeWindow.setSize(900, 700));
    await window.evaluate(async () => {
      const a = (window as any).app;
      for (const path of ["Alpha.md", "Beta.md", "Gamma.md"]) await a.openFile(a.vault.getFileByPath(path), true);
      const group = a.workspace.activeGroup;
      const byPath = (path: string) => group.leaves.find((leaf: any) => leaf.view?.getFile?.()?.path === path);
      const first = group.createCollection(byPath("Alpha.md"));
      group.addLeafToCollection(byPath("Gamma.md"), first.id);
      group.renameCollection(first.id, "First");
      const second = group.createCollection(byPath("Beta.md"));
      group.renameCollection(second.id, "Second");
    });
    const labels = window.locator(".tab-collection-label");
    await expect(labels).toHaveCount(2);
    await labels.nth(1).dragTo(labels.nth(0));
    const ordered = await window.evaluate(() => (window as any).app.workspace.serialize().center.root.leaves
      .map((leaf: any) => ({ file: leaf.file, collectionId: leaf.collectionId })));
    expect(ordered.map((leaf: any) => leaf.file)).toEqual(["Beta.md", "Alpha.md", "Gamma.md"]);
    expect(ordered[0].collectionId).not.toBe(ordered[1].collectionId);
    expect(ordered[1].collectionId).toBe(ordered[2].collectionId);
    await labels.nth(0).dragTo(labels.nth(1));
    expect(await window.evaluate(() => (window as any).app.workspace.serialize().center.root.leaves
      .map((leaf: any) => leaf.file))).toEqual(["Alpha.md", "Gamma.md", "Beta.md"]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("supports member reorder, member-out, transfer, collapsed append, and cancelled drag no-op", async () => {
  const { vaultDir, userDataDir } = fixture();
  fs.writeFileSync(path.join(vaultDir, "Delta.md"), "# Delta\n");
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    const browserWindow = await app.browserWindow(window);
    await browserWindow.evaluate((nativeWindow: any) => nativeWindow.setSize(1440, 900));
    await window.evaluate(async () => {
      const a = (window as any).app;
      for (const path of ["Alpha.md", "Beta.md", "Gamma.md", "Delta.md"]) await a.openFile(a.vault.getFileByPath(path), true);
      const group = a.workspace.activeGroup;
      const byPath = (path: string) => group.leaves.find((leaf: any) => leaf.view?.getFile?.()?.path === path);
      const first = group.createCollection(byPath("Alpha.md")); group.renameCollection(first.id, "First");
      group.addLeafToCollection(byPath("Gamma.md"), first.id);
      const second = group.createCollection(byPath("Beta.md")); group.renameCollection(second.id, "Second");
      await new Promise((resolve) => setTimeout(resolve, 0));
      group.renameCollection(first.id, "First");
      group.renameCollection(second.id, "Second");
      await new Promise((resolve) => setTimeout(resolve, 0));
      group.renameCollection(first.id, "First");
      group.renameCollection(second.id, "Second");
    });
    const alpha = window.locator('.workspace-tab-header[data-type="markdown"]', { hasText: "Alpha" });
    const gamma = window.locator('.workspace-tab-header[data-type="markdown"]', { hasText: "Gamma" });
    const delta = window.locator('.workspace-tab-header[data-type="markdown"]', { hasText: "Delta" });
    const gammaBox = (await gamma.boundingBox())!;
    await alpha.dragTo(gamma, { targetPosition: { x: gammaBox.width * 0.7, y: gammaBox.height / 2 } });
    expect(await window.evaluate(() => (window as any).app.workspace.activeGroup.leaves
      .filter((leaf: any) => leaf.collectionId && leaf.view?.getFile?.()?.path !== "Beta.md")
      .map((leaf: any) => leaf.view?.getFile?.()?.path))).toEqual(["Gamma.md", "Alpha.md"]);

    await alpha.dragTo(delta);
    expect(await window.evaluate(() => (window as any).app.workspace.activeGroup.leaves
      .find((leaf: any) => leaf.view?.getFile?.()?.path === "Alpha.md").collectionId)).toBeUndefined();
    await alpha.dragTo(window.locator(".tab-collection-label", { hasText: "Second" }));
    expect(await window.evaluate(() => {
      const group = (window as any).app.workspace.activeGroup;
      const alphaLeaf = group.leaves.find((leaf: any) => leaf.view?.getFile?.()?.path === "Alpha.md");
      return group.collectionForLeaf(alphaLeaf)?.name;
    })).toBe("Second");

    const firstLabel = window.locator(".tab-collection-label").first();
    await firstLabel.locator(".tab-collection-disclosure").click();
    await delta.dragTo(firstLabel);
    await expect(firstLabel).toHaveClass(/is-collapsed/);
    await expect(firstLabel.locator(".tab-collection-count")).toHaveText("2");
    const beforeCancel = await window.evaluate(() => JSON.stringify((window as any).app.workspace.serialize().center));
    const beta = window.locator('.workspace-tab-header[data-type="markdown"]', { hasText: "Beta" });
    await beta.evaluate((element) => {
      const dataTransfer = new DataTransfer();
      element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
      element.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    });
    expect(await window.evaluate(() => JSON.stringify((window as any).app.workspace.serialize().center))).toBe(beforeCancel);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("keeps member, ungrouped, and collection-block drop previews inside the visible tab bar", async () => {
  const { vaultDir, userDataDir } = fixture();
  fs.writeFileSync(path.join(vaultDir, "Delta.md"), "# Delta\n");
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    const browserWindow = await app.browserWindow(window);
    await browserWindow.evaluate((nativeWindow: any) => nativeWindow.setSize(900, 700));
    await window.evaluate(async () => {
      const a = (window as any).app;
      for (const file of ["Alpha.md", "Beta.md", "Gamma.md", "Delta.md"]) await a.openFile(a.vault.getFileByPath(file), true);
      const group = a.workspace.activeGroup;
      const byPath = (file: string) => group.leaves.find((leaf: any) => leaf.view?.getFile?.()?.path === file);
      const first = group.createCollection(byPath("Alpha.md")); group.renameCollection(first.id, "First");
      group.addLeafToCollection(byPath("Gamma.md"), first.id);
      const second = group.createCollection(byPath("Beta.md")); group.renameCollection(second.id, "Second");
    });

    const inspectPreview = async (sourceText: string, targetText: string, targetClass: string, fraction: number) => window.evaluate(
      ({ sourceText, targetText, targetClass, fraction }) => {
        const candidates = [...document.querySelectorAll<HTMLElement>(targetClass)];
        const sourceCandidates = [...document.querySelectorAll<HTMLElement>(sourceText.startsWith("collection:") ? ".tab-collection-label" : '.workspace-tab-header[data-type="markdown"]')];
        const source = sourceText.startsWith("collection:")
          ? sourceCandidates[Number(sourceText.slice("collection:".length))]
          : sourceCandidates.find((element) => element.textContent?.includes(sourceText))!;
        const target = targetText.startsWith("collection:")
          ? candidates[Number(targetText.slice("collection:".length))]
          : candidates.find((element) => element.textContent?.includes(targetText))!;
        const transfer = new DataTransfer();
        source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        const targetRect = target.getBoundingClientRect();
        target.dispatchEvent(new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: targetRect.left + targetRect.width * fraction,
          clientY: targetRect.top + targetRect.height / 2,
        }));
        const preview = document.querySelector<HTMLElement>(".tab-drop-preview")!;
        const previewRect = preview.getBoundingClientRect();
        const barRect = target.closest<HTMLElement>(".workspace-tab-header-container")!.getBoundingClientRect();
        const markerPseudo = target.classList.contains("tab-drop-before") ? "::before" : "::after";
        const marker = getComputedStyle(target, markerPseudo);
        const result = {
          text: preview.textContent,
          previewInsideBar: previewRect.top >= barRect.top && previewRect.bottom <= barRect.bottom
            && previewRect.left >= barRect.left && previewRect.right <= barRect.right,
          targetPosition: getComputedStyle(target).position,
          markerWidth: Number.parseFloat(marker.width),
          markerVisible: marker.content !== "none" && marker.backgroundColor !== "rgba(0, 0, 0, 0)",
        };
        source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: transfer }));
        return result;
      },
      { sourceText, targetText, targetClass, fraction },
    );

    const member = await inspectPreview("Delta", "Gamma", '.workspace-tab-header[data-type="markdown"]', 0.4);
    expect(member).toMatchObject({ previewInsideBar: true, targetPosition: "relative", markerWidth: 3, markerVisible: true });
    expect(member.text).toMatch(/^Move within /);
    const ungrouped = await inspectPreview("Alpha", "Delta", '.workspace-tab-header[data-type="markdown"]', 0.25);
    expect(ungrouped).toMatchObject({ text: "Ungrouped", previewInsideBar: true, targetPosition: "relative", markerWidth: 3, markerVisible: true });
    const block = await inspectPreview("collection:1", "collection:0", ".tab-collection-label", 0.5);
    expect(block).toMatchObject({ previewInsideBar: true, targetPosition: "relative", markerWidth: 3, markerVisible: true });
    expect(block.text).toMatch(/^Move collection before /);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("moves a cross-split collection-label drop as ungrouped with an accurate preview", async () => {
  const { vaultDir, userDataDir } = fixture();
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    const browserWindow = await app.browserWindow(window);
    await browserWindow.evaluate((nativeWindow: any) => nativeWindow.setSize(1440, 900));
    await window.evaluate(async () => {
      const a = (window as any).app;
      for (const file of ["Alpha.md", "Beta.md", "Gamma.md"]) await a.openFile(a.vault.getFileByPath(file), true);
      const source = a.workspace.activeGroup;
      const byPath = (group: any, file: string) => group.leaves.find((leaf: any) => leaf.view?.getFile?.()?.path === file);
      source.createCollection(byPath(source, "Alpha.md"));
      const destination = a.workspace.addGroup(source);
      a.workspace.moveLeaf(byPath(source, "Beta.md"), destination);
      a.workspace.moveLeaf(byPath(source, "Gamma.md"), destination);
      const collection = destination.createCollection(byPath(destination, "Beta.md"));
      destination.addLeafToCollection(byPath(destination, "Gamma.md"), collection.id);
      destination.renameCollection(collection.id, "Destination");
      await new Promise((resolve) => setTimeout(resolve, 0));
      destination.renameCollection(collection.id, "Destination");
      await new Promise((resolve) => setTimeout(resolve, 0));
      destination.renameCollection(collection.id, "Destination");
    });

    const groups = window.locator(".workspace-split.mod-root .workspace-tabs.mod-top");
    await expect(groups).toHaveCount(2);
    const alpha = groups.nth(0).locator('.workspace-tab-header[data-type="markdown"]', { hasText: "Alpha" });
    const destinationLabel = groups.nth(1).locator(".tab-collection-label", { hasText: "Destination" });
    const preview = await window.evaluate(() => {
      const groups = [...document.querySelectorAll<HTMLElement>(".workspace-split.mod-root .workspace-tabs.mod-top")];
      const source = [...groups[0].querySelectorAll<HTMLElement>('.workspace-tab-header[data-type="markdown"]')]
        .find((element) => element.textContent?.includes("Alpha"))!;
      const target = groups[1].querySelector<HTMLElement>(".tab-collection-label")!;
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      const text = document.querySelector<HTMLElement>(".tab-drop-preview")?.textContent;
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: transfer }));
      return text;
    });
    expect(preview).toBe("Move ungrouped before Destination");

    await alpha.dragTo(destinationLabel);
    const result = await window.evaluate(() => {
      const a = (window as any).app;
      const destination = a.workspace.groups[1];
      const alphaLeaf = destination.leaves.find((leaf: any) => leaf.view?.getFile?.()?.path === "Alpha.md");
      return {
        paths: destination.leaves.map((leaf: any) => leaf.view?.getFile?.()?.path),
        alphaCollectionId: alphaLeaf?.collectionId,
        collectionMembers: destination.leaves.filter((leaf: any) => leaf.collectionId)
          .map((leaf: any) => leaf.view?.getFile?.()?.path),
      };
    });
    expect(result).toEqual({ paths: ["Alpha.md", "Beta.md", "Gamma.md"], alphaCollectionId: undefined, collectionMembers: ["Beta.md", "Gamma.md"] });
    await expect(destinationLabel.locator(".tab-collection-count")).toHaveText("2");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("attempts every collection close and preserves failed first, middle, last, and final members", async () => {
  const { vaultDir, userDataDir } = fixture();
  fs.writeFileSync(path.join(vaultDir, "Delta.md"), "# Delta\n");
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    const result = await window.evaluate(async () => {
      const a = (window as any).app;
      for (const path of ["Alpha.md", "Beta.md", "Gamma.md", "Delta.md"]) await a.openFile(a.vault.getFileByPath(path), true);
      const group = a.workspace.activeGroup;
      const byPath = (path: string) => group.leaves.find((leaf: any) => leaf.view?.getFile?.()?.path === path);
      const collection = group.createCollection(byPath("Alpha.md"));
      for (const path of ["Beta.md", "Gamma.md"]) group.addLeafToCollection(byPath(path), collection.id);
      const final = group.createCollection(byPath("Delta.md"));
      const attempted: string[] = [];
      for (const path of ["Alpha.md", "Gamma.md", "Delta.md"]) {
        const leaf = byPath(path);
        leaf.detach = async () => { attempted.push(path); throw new Error(`blocked-${path}`); };
      }
      const beta = byPath("Beta.md");
      const originalBeta = beta.detach.bind(beta);
      beta.detach = async () => { attempted.push("Beta.md"); await originalBeta(); };
      await group.closeCollection(collection.id);
      await group.closeCollection(final.id);
      return {
        attempted,
        survivors: group.leaves.map((leaf: any) => leaf.view?.getFile?.()?.path).filter(Boolean),
        collections: group.collections.map((entry: any) => ({ id: entry.id, members: group.leaves.filter((leaf: any) => leaf.collectionId === entry.id).length })),
      };
    });
    expect(result.attempted).toEqual(["Alpha.md", "Beta.md", "Gamma.md", "Delta.md"]);
    expect(result.survivors).toEqual(expect.arrayContaining(["Alpha.md", "Gamma.md", "Delta.md"]));
    expect(result.survivors).not.toContain("Beta.md");
    expect(result.collections.map((entry: any) => entry.members)).toEqual([2, 1]);
    await expect(window.locator(".notice", { hasText: "could not be closed" }).first()).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
