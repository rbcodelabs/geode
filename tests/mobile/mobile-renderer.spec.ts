import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";

const mobileUrl = pathToFileURL(path.resolve(__dirname, "../../dist/mobile/index.html")).href;
const externalVaultProofUrl = `${mobileUrl}?external-vault-proof=1`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

async function resetProofVault(page: Page): Promise<void> {
  await page.goto(mobileUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

async function emulatePhoneSafeArea(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: 47, right: 0, bottom: 34, left: 0 },
  });
}

async function openExternalProofNote(page: Page): Promise<void> {
  await page.goto(externalVaultProofUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => (window as any).app.commands.execute("open-another-vault"));
  await page.getByRole("button", { name: "Choose folder in Files" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root))
    .toBe("external://browser-provider-proof");
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Notes/Proof.md"), false);
  });
}

async function openMobileBase(page: Page): Promise<void> {
  await openExternalProofNote(page);
  await page.evaluate(async () => {
    const host = window.hostServices!.vaultFiles;
    await host.mkdir("Tasks");
    await host.write("Tasks/Alpha.md", "---\nstatus: Todo\npriority: 1\nowner: Ada\n---\nAlpha body\n");
    await host.write("Tasks/Beta.md", "---\nstatus: Doing\npriority: 2\nowner: Bob\n---\nBeta body\n");
    await host.write("Tasks/Gamma.md", "---\nstatus: Done\npriority: 3\nowner: Cora\n---\nGamma body\n");
    await host.write("Views/Mobile.base", [
      "views:",
      "  - type: table",
      "    name: Table",
      "    order: [file.name, file.path, file.folder, note.status, note.priority, note.owner]",
      "  - type: cards",
      "    name: Cards",
      "    order: [file.name, note.status, note.priority, note.owner]",
      ""].join("\n"));
    const app = (window as any).app;
    await app.reconcileVault("manual");
    await app.openFile(app.vault.getFileByPath("Views/Mobile.base"), false);
  });
  await expect(page.locator(".base-view")).toBeVisible();
}

async function touchTap(target: Locator, pointerId: number): Promise<void> {
  const box = (await target.boundingBox())!;
  const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await target.dispatchEvent("pointerdown", { pointerId, pointerType: "touch", isPrimary: true, ...point });
  await target.dispatchEvent("pointerup", { pointerId, pointerType: "touch", isPrimary: true, ...point });
}

async function graphNodePoint(graph: Locator, id: string, offsetX = 0): Promise<{ clientX: number; clientY: number }> {
  return graph.evaluate((element, { nodeId, offset }) => {
    const positions = JSON.parse((element as HTMLElement).dataset.graphNodePositions!) as Record<string, [number, number]>;
    const [x, y] = positions[nodeId];
    const canvas = element.querySelector("canvas")!;
    const rect = canvas.getBoundingClientRect();
    const scale = Number((element as HTMLElement).dataset.graphScale);
    const panX = Number((element as HTMLElement).dataset.graphPanX);
    const panY = Number((element as HTMLElement).dataset.graphPanY);
    return {
      clientX: rect.left + rect.width / 2 + panX + x * scale + offset,
      clientY: rect.top + rect.height / 2 + panY + y * scale,
    };
  }, { nodeId: id, offset: offsetX });
}

test("@phone provides an accessible daily workspace with dismissible drawers", async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await resetProofVault(page);

  const nav = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(nav).toBeVisible();
  const primaryActions = ["Files", "Search", "New note", "Details", "More"];
  await expect(nav.getByRole("button")).toHaveCount(primaryActions.length);
  for (const name of primaryActions) {
    const button = nav.getByRole("button", { name });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  const navBox = (await nav.boundingBox())!;
  expect(navBox.y + navBox.height).toBeGreaterThanOrEqual(page.viewportSize()!.height - 1);
  const mainBox = (await page.locator(".app-main").boundingBox())!;
  expect(navBox.y).toBeGreaterThanOrEqual(mainBox.y + mainBox.height);
  const statusBox = (await page.locator(".status-bar").boundingBox())!;
  expect(navBox.y).toBeGreaterThanOrEqual(statusBox.y + statusBox.height);
  await expect(page.locator(".workspace-center > .workspace-tabs.is-mobile-center-active > .workspace-tab-header-container"))
    .toBeHidden();

  const leftDrawer = page.locator(".workspace-sidebar.mod-left");
  const backdrop = page.locator(".mobile-drawer-backdrop");
  await nav.getByRole("button", { name: "Files" }).click();
  await expect(leftDrawer).toHaveClass(/is-mobile-drawer-open/);
  await expect(backdrop).toBeVisible();
  await leftDrawer.getByRole("button", { name: "Close files drawer" }).click();
  await expect(backdrop).toBeHidden();

  await nav.getByRole("button", { name: "Files" }).click();
  await backdrop.click({ position: { x: 380, y: 400 } });
  await expect(leftDrawer).not.toHaveClass(/is-mobile-drawer-open/);

  await nav.getByRole("button", { name: "Files" }).click();
  await page.keyboard.press("Escape");
  await expect(leftDrawer).not.toHaveClass(/is-mobile-drawer-open/);

  await nav.getByRole("button", { name: "Files" }).click();
  await page.locator('.nav-file-title[data-path="Welcome.md"]').click();
  await expect(leftDrawer).not.toHaveClass(/is-mobile-drawer-open/);
  await expect(page.locator(".cm-editor")).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.closest(".workspace-sidebar") == null)).toBe(true);
  const editorContent = page.locator(".workspace-center > .workspace-tabs.is-mobile-center-active .cm-content");
  await editorContent.tap({ position: { x: 5, y: 5 } });
  await expect(page.locator(".workspace-center > .workspace-tabs.is-mobile-center-active .cm-content"))
    .toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("# Persisted on mobile\n\nSearchable daily workspace");
  await expect.poll(() => page.evaluate(() => window.hostServices!.vaultFiles.read("Welcome.md")))
    .toBe("# Persisted on mobile\n\nSearchable daily workspace");

  await nav.getByRole("button", { name: "Search" }).click();
  await expect(leftDrawer).toHaveClass(/is-mobile-drawer-open/);
  await page.locator(".search-input").fill("Searchable daily");
  await expect(page.locator(".search-result")).toContainText("Welcome");
  await page.locator(".search-result").first().click();
  await expect(leftDrawer).not.toHaveClass(/is-mobile-drawer-open/);

  await nav.getByRole("button", { name: "More" }).click();
  const moreMenu = page.locator(".menu.mod-mobile-more");
  await expect(moreMenu.locator(".menu-item-title"))
    .toHaveText(["Quick switcher", "Commands", "Settings"]);
  await moreMenu.getByText("Quick switcher", { exact: true }).click();
  await expect(page.getByPlaceholder("Find or create a note…")).toBeVisible();
  await page.keyboard.press("Escape");
  await nav.getByRole("button", { name: "More" }).click();
  await page.locator(".menu.mod-mobile-more").getByText("Commands", { exact: true }).click();
  await expect(page.getByPlaceholder("Type a command…")).toBeVisible();
  await page.keyboard.press("Escape");

  await nav.getByRole("button", { name: "New note" }).click();
  await expect.poll(() => page.evaluate(() => window.hostServices!.vaultFiles.list()))
    .toEqual(expect.arrayContaining([expect.objectContaining({ path: "Untitled.md" })]));
  await page.keyboard.press("Escape");

  await nav.getByRole("button", { name: "More" }).click();
  await page.locator(".menu.mod-mobile-more").getByText("Settings", { exact: true }).click();
  await expect(page.locator(".modal.mod-settings")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.reload();
  await nav.getByRole("button", { name: "Files" }).click();
  await page.locator('.nav-file-title[data-path="Welcome.md"]').click();
  await expect(leftDrawer).not.toHaveClass(/is-mobile-drawer-open/);
  await expect(page.locator(".cm-content")).toContainText("Persisted on mobile");

  await page.setViewportSize({ width: 844, height: 390 });
  let adaptiveNavBox = (await nav.boundingBox())!;
  expect(adaptiveNavBox.x).toBeGreaterThanOrEqual(0);
  expect(adaptiveNavBox.x + adaptiveNavBox.width).toBeLessThanOrEqual(844);
  expect(adaptiveNavBox.y + adaptiveNavBox.height).toBeGreaterThanOrEqual(389);
  let adaptiveStatusBox = (await page.locator(".status-bar").boundingBox())!;
  expect(adaptiveStatusBox.y + adaptiveStatusBox.height).toBeLessThanOrEqual(adaptiveNavBox.y);

  // A shrinking dynamic viewport models the keyboard-relevant layout: the
  // bar remains at the visible bottom while editor/status content stays above.
  await page.setViewportSize({ width: 390, height: 500 });
  adaptiveNavBox = (await nav.boundingBox())!;
  adaptiveStatusBox = (await page.locator(".status-bar").boundingBox())!;
  expect(adaptiveNavBox.y + adaptiveNavBox.height).toBeGreaterThanOrEqual(499);
  expect(adaptiveStatusBox.y + adaptiveStatusBox.height).toBeLessThanOrEqual(adaptiveNavBox.y);
  await page.setViewportSize({ width: 390, height: 844 });

  const phoneScreenshot = testInfo.outputPath("phone-daily-workspace.png");
  await page.screenshot({ path: phoneScreenshot, animations: "disabled" });
  await testInfo.attach("phone-daily-workspace", { path: phoneScreenshot, contentType: "image/png" });
  expect(errors).toEqual([]);
});

test("@phone keeps drawers and settings inside the device safe area", async ({ page }, testInfo) => {
  await emulatePhoneSafeArea(page);
  await resetProofVault(page);

  const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
  const backdrop = page.locator(".mobile-drawer-backdrop");
  const leftDrawer = page.locator(".workspace-sidebar.mod-left");
  const rightDrawer = page.locator(".workspace-sidebar.mod-right");

  await navigation.getByRole("button", { name: "Files" }).click();
  await expect(leftDrawer).toHaveClass(/is-mobile-drawer-open/);
  expect((await leftDrawer.boundingBox())!.y).toBeGreaterThanOrEqual(47);
  expect((await backdrop.boundingBox())!.y).toBeGreaterThanOrEqual(47);
  const filesScreenshot = testInfo.outputPath("phone-safe-area-files-drawer.png");
  await page.screenshot({ path: filesScreenshot, animations: "disabled" });
  await testInfo.attach("phone-safe-area-files-drawer", { path: filesScreenshot, contentType: "image/png" });
  await leftDrawer.getByRole("button", { name: "Close files drawer" }).click();

  await navigation.getByRole("button", { name: "Details" }).click();
  await expect(rightDrawer).toHaveClass(/is-mobile-drawer-open/);
  await expect(page.locator(".tooltip")).toBeHidden();
  expect((await rightDrawer.boundingBox())!.y).toBeGreaterThanOrEqual(47);
  const detailsScreenshot = testInfo.outputPath("phone-safe-area-details-drawer.png");
  await page.screenshot({ path: detailsScreenshot, animations: "disabled" });
  await testInfo.attach("phone-safe-area-details-drawer", { path: detailsScreenshot, contentType: "image/png" });
  await rightDrawer.getByRole("button", { name: "Close details drawer" }).click();

  await navigation.getByRole("button", { name: "More" }).click();
  await page.locator(".menu.mod-mobile-more").getByText("Settings", { exact: true }).click();

  const modal = page.locator(".modal.mod-settings");
  const modalContent = modal.locator(".modal-content");
  const tabHeader = modal.locator(".vertical-tab-header");
  const content = modal.locator(".vertical-tab-content-container");
  const modalBox = (await modal.boundingBox())!;
  const headerBox = (await tabHeader.boundingBox())!;
  const contentBox = (await content.boundingBox())!;

  expect(modalBox.x).toBeGreaterThanOrEqual(8);
  expect(modalBox.y).toBeGreaterThanOrEqual(47);
  expect(modalBox.x + modalBox.width).toBeLessThanOrEqual(page.viewportSize()!.width - 8);
  expect(modalBox.y + modalBox.height).toBeLessThanOrEqual(page.viewportSize()!.height - 34);
  expect(modalBox.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 18);
  expect(await modalContent.evaluate((element) => getComputedStyle(element).flexDirection)).toBe("column");
  expect(headerBox.width).toBeGreaterThanOrEqual(modalBox.width - 2);
  expect(headerBox.height).toBeLessThan(100);
  expect(contentBox.width).toBeGreaterThanOrEqual(modalBox.width - 34);

  const appearanceTab = tabHeader.getByText("Appearance", { exact: true });
  const communityTab = tabHeader.getByText("Community plugins & themes", { exact: true });
  expect((await appearanceTab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await communityTab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await communityTab.click();
  await expect(communityTab).toHaveClass(/is-active/);
  await expect(content.getByRole("heading", { name: "Web Viewer" })).toBeVisible();
  await appearanceTab.click();

  for (const item of await content.locator(".setting-item").all()) {
    const itemBox = (await item.boundingBox())!;
    const controlBox = (await item.locator(".setting-item-control").boundingBox())!;
    expect(controlBox.x).toBeGreaterThanOrEqual(itemBox.x);
    expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(itemBox.x + itemBox.width + 1);
  }

  const screenshot = testInfo.outputPath("phone-safe-area-settings.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("phone-safe-area-settings", { path: screenshot, contentType: "image/png" });
  const closeSettings = modal.getByRole("button", { name: "Close Settings" });
  const closeBox = (await closeSettings.boundingBox())!;
  expect(closeBox.width).toBeGreaterThanOrEqual(44);
  expect(closeBox.height).toBeGreaterThanOrEqual(44);
  await closeSettings.click();
  await expect(modal).toBeHidden();
  await expect(navigation.getByRole("button", { name: "More" })).toBeVisible();
});

test("@phone opens existing and new notes with touch inside the device safe area", async ({ page }, testInfo) => {
  await emulatePhoneSafeArea(page);
  await resetProofVault(page);

  const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
  const leftDrawer = page.locator(".workspace-sidebar.mod-left");
  await navigation.getByRole("button", { name: "Files" }).tap();
  const welcomeRow = leftDrawer.locator('.nav-file-title[data-path="Welcome.md"]');
  await expect(welcomeRow).toBeVisible();
  expect.soft((await welcomeRow.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await welcomeRow.tap();
  await expect(leftDrawer).not.toHaveClass(/is-mobile-drawer-open/);
  await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path))
    .toBe("Welcome.md");
  await expect(page.locator(".workspace-tabs.is-mobile-center-active .cm-content")).toContainText("Welcome");
  expect(await page.evaluate(() => document.activeElement?.closest(".cm-editor") !== null)).toBe(false);
  const existingGroup = page.locator(".workspace-center > .workspace-tabs.is-mobile-center-active");
  expect.soft((await existingGroup.boundingBox())!.y).toBeGreaterThanOrEqual(47);
  const existingScreenshot = testInfo.outputPath("phone-safe-area-existing-note.png");
  await page.screenshot({ path: existingScreenshot, animations: "disabled" });
  await testInfo.attach("phone-safe-area-existing-note", { path: existingScreenshot, contentType: "image/png" });

  await page.reload();
  await navigation.getByRole("button", { name: "Files" }).tap();
  await leftDrawer.locator('.nav-file-title[data-path="Welcome.md"]').tap();
  await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path))
    .toBe("Welcome.md");
  expect(await page.evaluate(() => document.activeElement?.closest(".cm-editor") !== null)).toBe(false);

  await navigation.getByRole("button", { name: "New note" }).tap();
  await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path))
    .toBe("Untitled.md");
  const newGroup = page.locator(".workspace-center > .workspace-tabs.is-mobile-center-active");
  await expect(newGroup.locator(".cm-editor")).toBeVisible();
  expect.soft((await newGroup.boundingBox())!.y).toBeGreaterThanOrEqual(47);
  const newScreenshot = testInfo.outputPath("phone-safe-area-new-note.png");
  await page.screenshot({ path: newScreenshot, animations: "disabled" });
  await testInfo.attach("phone-safe-area-new-note", { path: newScreenshot, contentType: "image/png" });
});

test("@phone keeps adaptive presentation out of persisted workspace state", async ({ page }) => {
  await resetProofVault(page);
  const nav = page.getByRole("navigation", { name: "Mobile navigation" });
  const persistedLeft = await page.evaluate(() => {
    const app = (window as any).app;
    app.workspace.leftSidebar.collapse();
    return app.workspace.serialize().left;
  });

  await nav.getByRole("button", { name: "Files" }).click();
  await expect(page.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
  expect(await page.evaluate(() => (window as any).app.workspace.leftSidebar.collapsed)).toBe(true);
  expect(await page.evaluate(() => (window as any).app.workspace.serialize().left)).toEqual(persistedLeft);

  await page.locator('.nav-file-title[data-path="Welcome.md"]').click();
  await nav.getByRole("button", { name: "Search" }).click();
  await page.locator(".search-input").fill("Welcome");
  await page.locator(".search-result").first().click();
  expect(await page.evaluate(() => (window as any).app.workspace.serialize().left)).toEqual(persistedLeft);

  await expect.poll(() => page.evaluate(async () =>
    ((await window.hostServices!.config.read("workspace")) as any)?.left?.collapsed
  )).toBe(true);

  await page.reload();
  expect(await page.evaluate(() => (window as any).app.workspace.leftSidebar.collapsed)).toBe(true);
  expect((await page.evaluate(() => (window as any).app.workspace.serialize().left)).collapsed).toBe(true);
});

test("@phone projects one active center group and preserves exact serialization across breakpoints", async ({ page }) => {
  await resetProofVault(page);
  const saved = await page.evaluate(async () => {
    const app = (window as any).app;
    const workspace = app.workspace;
    await app.openFile(app.vault.getFileByPath("Welcome.md"), false);
    const second = workspace.addGroup(workspace.activeGroup);
    app.openEmptyTab(second);
    workspace.setActiveGroup(second);
    const secondFile = await app.vault.create("Second.md", "# Dormant group");
    await app.openFile(secondFile, false);
    const state = workspace.serialize();
    await window.hostServices!.config.write("workspace", state);
    return state;
  });
  await page.reload();

  const groups = page.locator(".workspace-center > .workspace-tabs");
  await expect(groups).toHaveCount(2);
  await expect.poll(() => groups.evaluateAll((elements) =>
    elements.filter((element) => getComputedStyle(element).display !== "none").length
  )).toBe(1);
  await expect(page.locator(".workspace-center > .workspace-tabs.is-mobile-center-active")).toHaveCount(1);
  await expect(page.locator(".workspace-center > .workspace-center-resize-handle")).toBeHidden();
  expect(await page.evaluate(() => (window as any).app.workspace.serialize())).toEqual(saved);

  const nav = page.getByRole("navigation", { name: "Mobile navigation" });
  await nav.getByRole("button", { name: "Files" }).click();
  await page.locator('.nav-file-title[data-path="Welcome.md"]').click();
  await page.locator(".workspace-center > .workspace-tabs.is-mobile-center-active .cm-content").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("# Breakpoint continuity\n\nPreserve this text");
  const beforeResize = await page.evaluate(() => (window as any).app.workspace.serialize());

  await nav.getByRole("button", { name: "Files" }).click();
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.locator(".mobile-drawer-backdrop")).toBeHidden();
  await expect(page.locator(".workspace-sidebar.mod-left")).not.toHaveClass(/is-mobile-drawer-open/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".workspace-tabs.is-mobile-center-active .cm-editor"))
    .toContainText("Breakpoint continuity");
  expect(await page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("Welcome.md");
  expect(await page.evaluate(() => (window as any).app.workspace.serialize())).toEqual(beforeResize);
});

test("@phone exposes keyboard-operable files and details dialogs with restored focus", async ({ page }) => {
  await resetProofVault(page);
  const files = page.getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("button", { name: "Files" });
  await files.focus();
  await page.keyboard.press("Enter");
  const left = page.locator(".workspace-sidebar.mod-left");
  await expect(left).toHaveAttribute("role", "dialog");
  await page.keyboard.press("Escape");
  await expect(files).toBeFocused();

  const details = page.getByRole("button", { name: "Details", exact: true });
  await details.focus();
  await page.keyboard.press("Enter");
  const right = page.locator(".workspace-sidebar.mod-right");
  await expect(right).toHaveAttribute("aria-modal", "true");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.closest(".workspace-sidebar.mod-right") !== null)).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await expect(details).toBeFocused();
});

test("@tablet keeps navigation docked and preserves the active editor through orientation changes", async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await resetProofVault(page);

  const leftSidebar = page.locator(".workspace-sidebar.mod-left");
  await expect(leftSidebar).toBeVisible();
  await expect(page.locator(".mobile-drawer-backdrop")).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();

  await page.locator('.nav-file-title[data-path="Welcome.md"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("# Tablet continuity\n\nKeep this editor alive");
  const editor = page.locator(".cm-editor");
  await expect(editor).toContainText("Tablet continuity");

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(editor).toContainText("Tablet continuity");
  let navigationBox = (await page.getByRole("navigation", { name: "Mobile navigation" }).boundingBox())!;
  expect(navigationBox.y + navigationBox.height).toBeGreaterThanOrEqual(767);
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(editor).toContainText("Tablet continuity");
  await expect(page.locator(".workspace-sidebar.mod-left")).toBeVisible();
  await expect.poll(async () => (await page.locator(".workspace-center").boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(500);
  await expect.poll(async () => (await editor.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(480);
  await expect(page.locator(".workspace-sidebar.mod-right")).toBeHidden();
  navigationBox = (await page.getByRole("navigation", { name: "Mobile navigation" }).boundingBox())!;
  expect(navigationBox.y + navigationBox.height).toBeGreaterThanOrEqual(1023);
  expect(await page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("Welcome.md");

  const rightState = await page.evaluate(() => (window as any).app.workspace.serialize().right);
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.locator(".workspace-sidebar.mod-right")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as any).app.workspace.serialize().right)).toEqual(rightState);
  await expect(page.locator(".workspace-sidebar.mod-left")).toBeVisible();
  await expect.poll(async () => (await page.locator(".workspace-center").boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(500);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  const centerBox = (await page.locator(".workspace-center").boundingBox())!;
  const editorBox = (await editor.boundingBox())!;
  expect(centerBox.x).toBeGreaterThanOrEqual(0);
  expect(editorBox.x).toBeGreaterThanOrEqual(centerBox.x);
  await expect(page.locator(".cm-content")).toContainText("Tablet continuity");
  expect(await page.locator(".cm-content").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element.firstElementChild ?? element);
    const rect = range.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    return rect.left >= 0 && rect.left < viewport && rect.right > 0;
  })).toBe(true);

  const tabletScreenshot = testInfo.outputPath("tablet-daily-workspace.png");
  await page.screenshot({ path: tabletScreenshot, animations: "disabled" });
  await testInfo.attach("tablet-daily-workspace", { path: tabletScreenshot, contentType: "image/png" });
  expect(errors).toEqual([]);
});

test("@phone switches from managed storage to a selected Files vault in the current window", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(externalVaultProofUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root)).toBe("managed://default");

  await page.evaluate(() => (window as any).app.commands.execute("open-another-vault"));
  const modal = page.locator(".modal.mod-manage-vaults");
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "Choose folder in Files" }).click();

  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root))
    .toBe("external://browser-provider-proof");
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Notes/Proof.md"), false);
  });
  await expect(page.locator(".cm-content")).toContainText("provider-bytes");
  await expect(page.locator(".workspace-tabs")).toHaveCount(1);

  const eventCount = await page.evaluate(async () => {
    const app = (window as any).app;
    let count = 0;
    app.vault.on("modify", () => { count += 1; });
    await window.hostServices!.vaultFiles.write("Notes/Proof.md", "provider-edited");
    return count;
  });
  expect(eventCount).toBe(1);
  expect(errors).toEqual([]);
});

test("@phone flushes and detaches the old vault before activating a selected Files vault", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(externalVaultProofUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Welcome.md"), false);
    (window as any).__geodeMobileTest.writeDelayMs = 1_200;
    app.getActiveMarkdownView().editor.dispatch({
      changes: { from: 0, to: app.getActiveMarkdownView().editor.state.doc.length, insert: "managed-dirty" },
    });
    app.commands.execute("open-another-vault");
  });
  await page.locator(".modal.mod-manage-vaults .vault-switcher-row:not(.is-current)").first().click();
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root), { timeout: 8_000 })
    .toBe("external://browser-provider-proof");

  const durable = await page.evaluate(() => ({
    managed: JSON.parse(localStorage.getItem("geode:mobile-managed-vault:v1")!),
    external: JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!),
    listenerCount: (window as any).__geodeMobileTest.listenerCount(),
  }));
  expect(durable.managed.files).toContainEqual(["Welcome.md", expect.objectContaining({ data: "managed-dirty" })]);
  expect(durable.external.files).toContainEqual(["Notes/Proof.md", expect.objectContaining({ data: "provider-bytes" })]);
  expect(durable.external.files).not.toContainEqual(["Welcome.md", expect.anything()]);
  expect(durable.listenerCount).toBe(1);
  expect(errors).toEqual([]);
});

test("@phone serializes a same-target double tap into one vault switch", async ({ page }) => {
  await page.goto(externalVaultProofUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  let reloads = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) reloads += 1;
  });
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Welcome.md"), false);
    (window as any).__geodeMobileTest.writeDelayMs = 1_200;
    app.getActiveMarkdownView().editor.dispatch({
      changes: { from: 0, to: app.getActiveMarkdownView().editor.state.doc.length, insert: "double-tap-dirty" },
    });
    const counts = { preflight: 0, prepare: 0, teardown: 0, activation: 0 };
    sessionStorage.setItem("geode:vault-switch-counts", JSON.stringify(counts));
    const bump = (key: keyof typeof counts) => {
      const current = JSON.parse(sessionStorage.getItem("geode:vault-switch-counts")!);
      current[key] += 1;
      sessionStorage.setItem("geode:vault-switch-counts", JSON.stringify(current));
    };
    const registry = app.host.vaultRegistry;
    const checkVault = registry.checkVault.bind(registry);
    registry.checkVault = async (...args: any[]) => { bump("preflight"); return checkVault(...args); };
    const openVault = registry.openVault.bind(registry);
    registry.openVault = async (...args: any[]) => { bump("activation"); return openVault(...args); };
    const prepare = app.workspace.prepareVaultSwitch.bind(app.workspace);
    app.workspace.prepareVaultSwitch = async () => { bump("prepare"); return prepare(); };
    const teardown = app.workspace.closeAllLeaves.bind(app.workspace);
    app.workspace.closeAllLeaves = async () => { bump("teardown"); return teardown(); };
    app.commands.execute("open-another-vault");
  });
  const modal = page.locator(".modal.mod-manage-vaults");
  const target = modal.locator(".vault-switcher-row:not(.is-current)").first();
  const disabledDuringSwitch = await target.evaluate((button: HTMLButtonElement) => {
    button.click();
    void (window as any).app.switchVaultInWindow("external://browser-provider-proof");
    button.click();
    return [...button.closest(".modal")!.querySelectorAll<HTMLButtonElement>("button")]
      .every((candidate) => candidate.disabled);
  });
  expect(disabledDuringSwitch).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root), { timeout: 8_000 })
    .toBe("external://browser-provider-proof");
  expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem("geode:vault-switch-counts")!)))
    .toEqual({ preflight: 1, prepare: 1, teardown: 1, activation: 1 });
  expect(reloads).toBe(1);
  const durable = await page.evaluate(() => ({
    managed: JSON.parse(localStorage.getItem("geode:mobile-managed-vault:v1")!),
    launch: localStorage.getItem("geode:mobile-launch-vault:v1"),
    listenerCount: (window as any).__geodeMobileTest.listenerCount(),
  }));
  expect(durable.managed.files).toContainEqual(["Welcome.md", expect.objectContaining({ data: "double-tap-dirty" })]);
  expect(durable.launch).toBe("external://browser-provider-proof");
  expect(durable.listenerCount).toBe(1);
});

test("@phone keeps the first target when two vault rows are tapped rapidly", async ({ page }) => {
  await page.goto(externalVaultProofUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  let reloads = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) reloads += 1;
  });
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Welcome.md"), false);
    (window as any).__geodeMobileTest.writeDelayMs = 1_200;
    app.getActiveMarkdownView().editor.dispatch({
      changes: { from: 0, to: app.getActiveMarkdownView().editor.state.doc.length, insert: "first-target-wins" },
    });
    const counts = { preflight: 0, prepare: 0, teardown: 0, activation: 0 };
    sessionStorage.setItem("geode:vault-switch-counts", JSON.stringify(counts));
    const bump = (key: keyof typeof counts) => {
      const current = JSON.parse(sessionStorage.getItem("geode:vault-switch-counts")!);
      current[key] += 1;
      sessionStorage.setItem("geode:vault-switch-counts", JSON.stringify(current));
    };
    const registry = app.host.vaultRegistry;
    const checkVault = registry.checkVault.bind(registry);
    registry.checkVault = async (...args: any[]) => { bump("preflight"); return checkVault(...args); };
    const openVault = registry.openVault.bind(registry);
    registry.openVault = async (...args: any[]) => { bump("activation"); return openVault(...args); };
    const prepare = app.workspace.prepareVaultSwitch.bind(app.workspace);
    app.workspace.prepareVaultSwitch = async () => { bump("prepare"); return prepare(); };
    const teardown = app.workspace.closeAllLeaves.bind(app.workspace);
    app.workspace.closeAllLeaves = async () => { bump("teardown"); return teardown(); };
    app.commands.execute("open-another-vault");
  });
  const modal = page.locator(".modal.mod-manage-vaults");
  const first = modal.locator(".vault-switcher-row:not(.is-current)").nth(0);
  await expect(modal.locator(".vault-switcher-row:not(.is-current)")).toHaveCount(2);
  const disabledDuringSwitch = await first.evaluate((button: HTMLButtonElement) => {
    const secondButton = button.closest(".vault-switcher-list")!
      .querySelectorAll<HTMLButtonElement>(".vault-switcher-row:not(.is-current)")[1];
    button.click();
    void (window as any).app.switchVaultInWindow("external://browser-provider-second").catch((error: any) => {
      sessionStorage.setItem("geode:vault-switch-busy-code", error.code);
    });
    secondButton.click();
    return [...button.closest(".modal")!.querySelectorAll<HTMLButtonElement>("button")]
      .every((candidate) => candidate.disabled);
  });
  expect(disabledDuringSwitch).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root), { timeout: 8_000 })
    .toBe("external://browser-provider-proof");
  expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem("geode:vault-switch-counts")!)))
    .toEqual({ preflight: 1, prepare: 1, teardown: 1, activation: 1 });
  expect(reloads).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem("geode:vault-switch-busy-code")))
    .toBe("VAULT_SWITCH_BUSY");
  const state = await page.evaluate(() => ({
    launch: localStorage.getItem("geode:mobile-launch-vault:v1"),
    current: (window as any).app.vault.root,
    first: JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!),
    second: JSON.parse(localStorage.getItem("geode:external-proof-second:geode:mobile-managed-vault:v1")!),
    listenerCount: (window as any).__geodeMobileTest.listenerCount(),
  }));
  expect(state.launch).toBe("external://browser-provider-proof");
  expect(state.current).toBe("external://browser-provider-proof");
  expect(state.first.files).toContainEqual(["Notes/Proof.md", expect.objectContaining({ data: "provider-bytes" })]);
  expect(state.second.files).toContainEqual(["Notes/Second.md", expect.objectContaining({ data: "second-provider-bytes" })]);
  expect(state.listenerCount).toBe(1);
});

test("@phone aborts a vault switch when dirty-editor flush fails and retries without losing text", async ({ page }) => {
  await page.goto(externalVaultProofUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Welcome.md"), false);
    app.getActiveMarkdownView().editor.dispatch({
      changes: { from: 0, to: app.getActiveMarkdownView().editor.state.doc.length, insert: "retryable-dirty" },
    });
    (window as any).__geodeMobileTest.failNextWrite = true;
    app.commands.execute("open-another-vault");
  });
  const modal = page.locator(".modal.mod-manage-vaults");
  await modal.locator(".vault-switcher-row:not(.is-current)").first().click();
  await expect(modal.locator(".vault-switcher-error")).toContainText("Injected browser write failure");
  await expect(modal.locator("button:disabled")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).app.vault.root)).toBe("managed://default");
  expect(await page.locator(".cm-content").innerText()).toContain("retryable-dirty");
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Welcome.md"))).not.toBe("retryable-dirty");

  await modal.locator(".vault-switcher-row:not(.is-current)").first().click();
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root), { timeout: 8_000 })
    .toBe("external://browser-provider-proof");
  const managed = await page.evaluate(() => JSON.parse(localStorage.getItem("geode:mobile-managed-vault:v1")!));
  expect(managed.files).toContainEqual(["Welcome.md", expect.objectContaining({ data: "retryable-dirty" })]);
});

test("@phone reconnects the exact failed recent vault while the current vault remains live", async ({ page }) => {
  await page.goto(externalVaultProofUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => {
    (window as any).__geodeMobileTest.externalAccess = "missing";
    (window as any).app.commands.execute("open-another-vault");
  });
  const modal = page.locator(".modal.mod-manage-vaults");
  await modal.locator(".vault-switcher-row:not(.is-current)").first().click();
  await expect(modal.locator(".vault-switcher-error")).toContainText("Reconnect Provider Vault");
  await expect(modal.getByRole("button", { name: "Reconnect" })).toBeVisible();
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Welcome.md"))).toContain("Welcome");

  await page.evaluate(() => { (window as any).__geodeMobileTest.reconnectResult = "cancel"; });
  await modal.getByRole("button", { name: "Reconnect" }).click();
  await expect(modal.locator(".vault-switcher-error")).toContainText("Reconnect canceled");
  expect(await page.evaluate(() => (window as any).app.vault.root)).toBe("managed://default");

  await page.evaluate(() => { (window as any).__geodeMobileTest.reconnectResult = "error"; });
  await modal.getByRole("button", { name: "Reconnect" }).click();
  await expect(modal.locator(".vault-switcher-error")).toContainText("temporarily unavailable");
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Welcome.md"))).toContain("Welcome");

  await page.evaluate(() => { (window as any).__geodeMobileTest.reconnectResult = "success"; });
  await modal.getByRole("button", { name: "Reconnect" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root), { timeout: 8_000 })
    .toBe("external://browser-provider-proof");
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Notes/Proof.md"), false);
  });
  await expect(page.locator(".cm-content")).toContainText("provider-bytes");
});

test("@phone @tablet foreground reconciliation reloads a clean provider edit in place", async ({ page }) => {
  await openExternalProofNote(page);
  await page.evaluate(() => {
    const testApi = (window as any).__geodeMobileTest;
    testApi.externalWrite("Notes/Proof.md", "provider-external-clean");
    testApi.foreground();
  });
  await expect(page.locator(".cm-content")).toContainText("provider-external-clean");
  await expect(page.locator(".editor-conflict-banner")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__geodeMobileTest.reconcileTrace)).toEqual(["scan"]);
  expect(await page.evaluate(() => (window as any).__geodeMobileTest.listenerCount())).toBe(1);
});

test("@phone foreground reconciliation preserves dirty local and provider bytes as a conflict", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeDate = Date;
    const instant = new NativeDate("2026-08-29T14:30:12");
    class FixedDate extends NativeDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        super(...(args.length ? args : [instant.getTime()]));
      }
      static now() { return instant.getTime(); }
    }
    Object.defineProperty(window, "Date", { value: FixedDate });
  });
  await openExternalProofNote(page);
  await page.evaluate(() => {
    const app = (window as any).app;
    app.getActiveMarkdownView().editor.dispatch({
      changes: { from: 0, to: app.getActiveMarkdownView().editor.state.doc.length, insert: "local-dirty-version" },
    });
    const testApi = (window as any).__geodeMobileTest;
    testApi.externalWrite("Notes/Proof.md", "provider-external-version");
    testApi.foreground();
  });
  const banner = page.locator(".editor-conflict-banner");
  await expect(banner).toContainText("Your local edit was preserved");
  await expect(banner.getByRole("button", { name: "Open provider version" })).toBeVisible();
  await expect(banner.getByRole("button", { name: "Open conflict copy" })).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("local-dirty-version");
  await expect(page.locator(".cm-content")).toHaveAttribute("aria-readonly", "true");

  const durable = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return {
      files: stored.files,
      trace: (window as any).__geodeMobileTest.reconcileTrace,
    };
  });
  expect(durable.files).toContainEqual(["Notes/Proof.md", expect.objectContaining({ data: "provider-external-version" })]);
  expect(durable.files).toContainEqual([
    "Notes/Proof (Geode conflict 2026-08-29 143012).md",
    expect.objectContaining({ data: "local-dirty-version" }),
  ]);
  expect(durable.trace).toEqual(["scan", "write:Notes/Proof (Geode conflict 2026-08-29 143012).md"]);
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!))).files)
    .toHaveLength(7);
});

test("@phone conflict naming numbers collisions and failed copy retains device recovery", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeDate = Date;
    const instant = new NativeDate("2026-08-29T14:30:12");
    class FixedDate extends NativeDate {
      constructor(...args: ConstructorParameters<typeof Date>) { super(...(args.length ? args : [instant.getTime()])); }
      static now() { return instant.getTime(); }
    }
    Object.defineProperty(window, "Date", { value: FixedDate });
  });
  await openExternalProofNote(page);
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.vault.create("Notes/Proof (Geode conflict 2026-08-29 143012).md", "occupied");
    app.getActiveMarkdownView().editor.dispatch({
      changes: { from: 0, to: app.getActiveMarkdownView().editor.state.doc.length, insert: "collision-local" },
    });
    const testApi = (window as any).__geodeMobileTest;
    testApi.externalWrite("Notes/Proof.md", "collision-provider");
    testApi.foreground();
  });
  await expect(page.locator(".editor-conflict-banner")).toBeVisible();
  let stored = await page.evaluate(() => JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!));
  expect(stored.files).toContainEqual([
    "Notes/Proof (Geode conflict 2026-08-29 143012) 2.md",
    expect.objectContaining({ data: "collision-local" }),
  ]);

  await page.locator(".editor-conflict-banner").getByRole("button", { name: "Open provider version" }).click();
  await page.evaluate(() => {
    const app = (window as any).app;
    app.getActiveMarkdownView().editor.dispatch({
      changes: { from: 0, to: app.getActiveMarkdownView().editor.state.doc.length, insert: "recovery-local" },
    });
    const testApi = (window as any).__geodeMobileTest;
    testApi.failConflictCopy = true;
    testApi.externalWrite("Notes/Proof.md", "recovery-provider");
    testApi.foreground();
  });
  await expect(page.locator(".editor-conflict-banner")).toContainText("device recovery storage");
  const recovery = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("geode:conflict-recovery:"))!;
    return JSON.parse(localStorage.getItem(key)!);
  });
  expect(recovery).toMatchObject({
    vaultId: "external://browser-provider-proof",
    path: "Notes/Proof.md",
    text: "recovery-local",
  });
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!));
  expect(stored.files).toContainEqual(["Notes/Proof.md", expect.objectContaining({ data: "recovery-provider" })]);
  await page.waitForTimeout(300);
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root))
    .toBe("external://browser-provider-proof");
  await expect(page.locator(".editor-conflict-banner")).toContainText("device recovery storage");
  await expect(page.locator(".cm-content")).toContainText("recovery-local");
  await expect(page.locator(".cm-content")).toHaveAttribute("aria-readonly", "true");
});

test("@phone partial foreground scan retains the prior manifest and emits no delete", async ({ page }) => {
  await openExternalProofNote(page);
  const before = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return stored.config.find(([key]: [string]) => key.startsWith("device-reconcile:"));
  });
  await page.evaluate(() => {
    const testApi = (window as any).__geodeMobileTest;
    testApi.externalDelete("Notes/Proof.md");
    testApi.reconcileStatus = "partial";
    testApi.foreground();
  });
  await expect(page.locator(".vault-reconcile-state")).toContainText("previous file manifest is still active");
  expect(await page.evaluate(() => (window as any).app.vault.getFileByPath("Notes/Proof.md")?.path)).toBe("Notes/Proof.md");
  const after = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return stored.config.find(([key]: [string]) => key.startsWith("device-reconcile:"));
  });
  expect(after).toEqual(before);
  await page.evaluate(() => {
    (window as any).__geodeMobileTest.reconcileStatus = "complete";
    (window as any).app.commands.execute("refresh-vault");
  });
  await expect.poll(() => page.evaluate(() => (window as any).app.vault.getFileByPath("Notes/Proof.md"))).toBeNull();
});

test("@phone cold relaunch reconciles an existing manifest for external edit and delete", async ({ page }) => {
  await openExternalProofNote(page);
  await page.evaluate(() => {
    const testApi = (window as any).__geodeMobileTest;
    testApi.externalWrite("Notes/Proof.md", "cold-provider-edit");
    testApi.externalDelete("Boards/Proof.canvas");
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).__geodeMobileTest.reconcileTrace)).toEqual(["scan"]);
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Notes/Proof.md"), false);
  });
  await expect(page.locator(".cm-content")).toContainText("cold-provider-edit");
  expect(await page.evaluate(() => (window as any).app.vault.getAbstractFileByPath("Boards/Proof.canvas"))).toBeNull();
  const manifest = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return stored.config.find(([key]: [string]) => key.startsWith("device-reconcile:"))[1];
  });
  expect(manifest.entries["Notes/Proof.md"]).toBeDefined();
  expect(manifest.entries["Boards/Proof.canvas"]).toBeUndefined();
});

test("@phone cold relaunch repairs alias-corrupted managed paths without mutating vault bytes", async ({ page }) => {
  await page.goto(externalVaultProofUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root)).toBe("managed://default");
  const filesBefore = await page.evaluate(() => {
    const key = "geode:mobile-managed-vault:v1";
    const stored = JSON.parse(localStorage.getItem(key)!);
    const config = stored.config.find(([name]: [string]) => name.startsWith("device-reconcile:"));
    const manifest = config[1];
    manifest.entries = Object.fromEntries(
      Object.values(manifest.entries).map((value: any) => [
        `e Vault/${value.path}`,
        { ...value, path: `e Vault/${value.path}` },
      ]),
    );
    localStorage.setItem(key, JSON.stringify(stored));
    return stored.files;
  });

  await page.reload();

  await expect.poll(() => page.evaluate(() => (window as any).__geodeMobileTest.reconcileTrace)).toEqual(["scan"]);
  expect(await page.evaluate(() => (window as any).app.vault.getMarkdownFiles().map((file: any) => file.path)))
    .toEqual(["Welcome.md"]);
  const repaired = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:mobile-managed-vault:v1")!);
    const manifest = stored.config.find(([name]: [string]) => name.startsWith("device-reconcile:"))[1];
    return { files: stored.files, paths: Object.keys(manifest.entries) };
  });
  expect(repaired.paths).toEqual(["Welcome.md"]);
  expect(repaired.files).toEqual(filesBefore);
});

test("@phone failed processing or manifest commit retains the prior manifest and retries exact bytes", async ({ page }) => {
  await openExternalProofNote(page);
  const before = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return stored.config.find(([key]: [string]) => key.startsWith("device-reconcile:"));
  });
  await page.evaluate(() => {
    const app = (window as any).app;
    const original = app.host.config.write.bind(app.host.config);
    let reject = true;
    app.host.config.write = async (key: string, value: unknown) => {
      if (reject && key.startsWith("device-reconcile:")) {
        reject = false;
        throw new Error("Injected manifest commit failure");
      }
      return original(key, value);
    };
    const testApi = (window as any).__geodeMobileTest;
    testApi.externalWrite("Notes/Proof.md", "retry-provider-bytes");
    testApi.foreground();
  });
  await expect(page.locator(".vault-reconcile-state")).toContainText("temporarily unavailable");
  await expect(page.locator(".cm-content")).toContainText("provider-bytes");
  expect(await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return stored.config.find(([key]: [string]) => key.startsWith("device-reconcile:"));
  })).toEqual(before);
  await page.getByRole("button", { name: "Retry refresh" }).click();
  await expect(page.locator(".vault-reconcile-state")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("retry-provider-bytes");
});

test("@phone failed provider read does not advance the manifest and retry remains lossless", async ({ page }) => {
  await openExternalProofNote(page);
  const before = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return stored.config.find(([key]: [string]) => key.startsWith("device-reconcile:"));
  });
  await page.evaluate(() => {
    const app = (window as any).app;
    const original = app.host.vaultFiles.read.bind(app.host.vaultFiles);
    let reject = true;
    app.host.vaultFiles.read = async (path: string) => {
      if (reject && path === "Notes/Proof.md") {
        reject = false;
        throw new Error("Injected provider read failure");
      }
      return original(path);
    };
    const testApi = (window as any).__geodeMobileTest;
    testApi.externalWrite("Notes/Proof.md", "read-retry-provider");
    testApi.foreground();
  });
  await expect(page.locator(".vault-reconcile-state")).toContainText("temporarily unavailable");
  await expect(page.locator(".cm-content")).toContainText("provider-bytes");
  expect(await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return stored.config.find(([key]: [string]) => key.startsWith("device-reconcile:"));
  })).toEqual(before);
  await page.getByRole("button", { name: "Retry refresh" }).click();
  await expect(page.locator(".cm-content")).toContainText("read-retry-provider");
});

test("@phone recovery quota failure keeps the dirty editor read-only and manifest retryable", async ({ page }) => {
  await openExternalProofNote(page);
  const before = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return stored.config.find(([key]: [string]) => key.startsWith("device-reconcile:"));
  });
  await page.evaluate(() => {
    const app = (window as any).app;
    app.getActiveMarkdownView().editor.dispatch({
      changes: { from: 0, to: app.getActiveMarkdownView().editor.state.doc.length, insert: "quota-local" },
    });
    const nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      if (key.startsWith("geode:conflict-recovery:")) throw new DOMException("quota", "QuotaExceededError");
      return nativeSetItem.call(this, key, value);
    };
    const testApi = (window as any).__geodeMobileTest;
    testApi.failConflictCopy = true;
    testApi.externalWrite("Notes/Proof.md", "quota-provider");
    testApi.foreground();
  });
  await expect(page.locator(".editor-conflict-banner")).toContainText("held in memory only");
  await expect(page.locator(".cm-content")).toContainText("quota-local");
  await expect(page.locator(".cm-content")).toHaveAttribute("aria-readonly", "true");
  expect(await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return stored.config.find(([key]: [string]) => key.startsWith("device-reconcile:"));
  })).toEqual(before);
});

test("@phone delayed reconciliation makes Base and Canvas non-editable until external decisions finish", async ({ page }) => {
  await openExternalProofNote(page);
  for (const path of ["Views/Proof.base", "Boards/Proof.canvas"]) {
    await page.evaluate(async (filePath) => {
      const app = (window as any).app;
      await app.openFile(app.vault.getFileByPath(filePath), false);
      const originalRead = app.host.vaultFiles.read.bind(app.host.vaultFiles);
      (window as any).__reconcileTextReads = [];
      app.host.vaultFiles.read = async (path: string) => {
        if (path === filePath) (window as any).__reconcileTextReads.push(new Error().stack);
        return originalRead(path);
      };
      const testApi = (window as any).__geodeMobileTest;
      testApi.reconcileDelayMs = 300;
      testApi.externalWrite(filePath, filePath.endsWith(".base")
        ? "views:\n  - type: cards\n    name: Provider\n"
        : '{"nodes":[{"id":"provider","type":"text","x":0,"y":0,"width":100,"height":100,"text":"provider"}],"edges":[]}');
      testApi.foreground();
    }, path);
    const selector = path.endsWith(".base") ? ".base-view" : ".canvas-view";
    await expect(page.locator(selector)).toHaveAttribute("inert", "");
    await expect(page.locator(selector)).not.toHaveAttribute("inert", "", { timeout: 5_000 });
    await expect.poll(() => page.evaluate(() => {
      const view = (window as any).app.workspace.getActiveLeaf().view;
      return String(view.lastKnownText ?? "").toLowerCase();
    })).toContain("provider");
    expect(await page.evaluate(() => (window as any).__reconcileTextReads), path).toHaveLength(1);
    expect((await page.evaluate((filePath) => window.hostServices!.vaultFiles.read(filePath), path)).toLowerCase())
      .toContain("provider");
  }
});

test("@phone Base apply failure keeps the old manifest and view inert until retry succeeds", async ({ page }) => {
  await openExternalProofNote(page);
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Views/Proof.base"), false);
  });
  const before = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return stored.config.find(([key]: [string]) => key.startsWith("device-reconcile:"));
  });
  await page.evaluate(() => {
    const app = (window as any).app;
    const view = app.workspace.getActiveLeaf().view;
    const original = view.acceptExternalText.bind(view);
    let reject = true;
    view.acceptExternalText = async (text: string) => {
      if (reject) { reject = false; throw new Error("Injected Base apply failure"); }
      return original(text);
    };
    const testApi = (window as any).__geodeMobileTest;
    testApi.externalWrite("Views/Proof.base", "views:\n  - type: cards\n    name: ProviderRetry\n");
    testApi.foreground();
  });
  await expect(page.locator(".vault-reconcile-state")).toContainText("temporarily unavailable");
  await expect(page.locator(".base-view")).toHaveAttribute("inert", "");
  expect(await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return stored.config.find(([key]: [string]) => key.startsWith("device-reconcile:"));
  })).toEqual(before);
  await page.getByRole("button", { name: "Retry refresh" }).click();
  await expect(page.locator(".base-view")).not.toHaveAttribute("inert", "");
  await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveLeaf().view.lastKnownText))
    .toContain("ProviderRetry");
});

test("@phone binary attachment reconciliation advances metadata without a UTF-8 text read", async ({ page }) => {
  await openExternalProofNote(page);
  await page.evaluate(() => {
    const app = (window as any).app;
    const original = app.host.vaultFiles.read.bind(app.host.vaultFiles);
    app.host.vaultFiles.read = async (path: string) => {
      if (path === "Assets/blob.bin") throw new Error("Binary path was incorrectly read as UTF-8");
      return original(path);
    };
    const testApi = (window as any).__geodeMobileTest;
    testApi.externalWrite("Assets/blob.bin", "\u0000\u00ffreplacement");
    testApi.foreground();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__geodeMobileTest.reconcileTrace)).toEqual(["scan"]);
  await expect(page.locator(".vault-reconcile-state")).toHaveCount(0);
  const bytes = await page.evaluate(async () => [...new Uint8Array(await window.hostServices!.vaultFiles.readBinary("Assets/blob.bin"))]);
  expect(bytes).toEqual([...new TextEncoder().encode("\u0000\u00ffreplacement")]);
  const manifest = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("geode:external-proof:geode:mobile-managed-vault:v1")!);
    return stored.config.find(([key]: [string]) => key.startsWith("device-reconcile:"))[1];
  });
  expect(manifest.entries["Assets/blob.bin"].size).toBe(bytes.length);
});

test("@phone a delayed reconcile settles before vault switch and foreground cannot cross roots", async ({ page }) => {
  await openExternalProofNote(page);
  await page.evaluate(() => {
    const app = (window as any).app;
    const testApi = (window as any).__geodeMobileTest;
    testApi.reconcileDelayMs = 300;
    void app.reconcileVault("manual");
    void app.switchVaultInWindow("external://browser-provider-second");
    testApi.foreground();
  });
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root), { timeout: 8_000 })
    .toBe("external://browser-provider-second");
  expect(await page.evaluate(() => (window as any).__geodeMobileTest.listenerCount())).toBe(1);
  await expect.poll(() => page.evaluate(() => window.hostServices!.vaultFiles.read("Notes/Second.md")))
    .toBe("second-provider-bytes");
});

test("@phone @tablet Graph supports touch selection, open, pan, pinch, controls, cancellation, and restore", async ({ page }) => {
  await openExternalProofNote(page);
  await page.evaluate(() => (window as any).app.openGraphView());
  const graph = page.locator(".graph-view");
  const canvas = graph.locator(".graph-view-canvas");
  await expect(graph).toHaveAttribute("data-graph-node-count", "3");
  await expect(graph).toHaveAttribute("data-graph-edge-count", "1");
  await expect.poll(async () => graph.getAttribute("data-graph-node-positions")).not.toBeNull();

  const controls = graph.getByRole("toolbar", { name: "Graph controls" }).getByRole("button");
  await expect(controls).toHaveCount(7);
  for (let index = 0; index < 7; index += 1) {
    const box = await controls.nth(index).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  const nodePoint = await graphNodePoint(graph, "Notes/Proof.md");
  await canvas.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", isPrimary: true, ...nodePoint });
  await canvas.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", isPrimary: true, ...nodePoint });
  await expect(graph).toHaveAttribute("data-graph-selected", "Notes/Proof.md");
  await expect(page.locator(".workspace-center .workspace-tab-header.is-active .workspace-tab-header-inner-title")).toHaveText("Graph view");

  await graph.getByRole("button", { name: "Open selected note" }).click();
  await expect(page.locator(".workspace-center .workspace-tab-header.is-active .workspace-tab-header-inner-title")).toHaveText("Proof");
  if (page.viewportSize()!.width <= 700) {
    const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
    await navigation.getByRole("button", { name: "More" }).click();
    await page.locator(".menu.mod-mobile-more").getByText("Commands", { exact: true }).click();
    await page.getByPlaceholder("Type a command…").fill("Graph view");
    await page.getByText("Graph view: Open graph view", { exact: true }).click();
  } else {
    await page.locator('.workspace-tab-header-inner-title:text-is("Graph view")').click();
  }
  await expect(graph).toBeVisible();

  const canvasBox = (await canvas.boundingBox())!;
  const beforePan = Number(await graph.getAttribute("data-graph-pan-x"));
  const empty = { clientX: canvasBox.x + 20, clientY: canvasBox.y + canvasBox.height - 24 };
  await canvas.dispatchEvent("pointerdown", { pointerId: 2, pointerType: "touch", isPrimary: true, ...empty });
  await canvas.dispatchEvent("pointermove", { pointerId: 2, pointerType: "touch", isPrimary: true, clientX: empty.clientX + 35, clientY: empty.clientY - 10 });
  await canvas.dispatchEvent("pointerup", { pointerId: 2, pointerType: "touch", isPrimary: true, clientX: empty.clientX + 35, clientY: empty.clientY - 10 });
  expect(Number(await graph.getAttribute("data-graph-pan-x"))).toBeGreaterThan(beforePan + 30);

  const beforeScale = Number(await graph.getAttribute("data-graph-scale"));
  const centerX = canvasBox.x + canvasBox.width / 2;
  const centerY = canvasBox.y + canvasBox.height / 2;
  await canvas.dispatchEvent("pointerdown", { pointerId: 3, pointerType: "touch", isPrimary: true, clientX: centerX - 30, clientY: centerY });
  await canvas.dispatchEvent("pointerdown", { pointerId: 4, pointerType: "touch", isPrimary: false, clientX: centerX + 30, clientY: centerY });
  await canvas.dispatchEvent("pointermove", { pointerId: 3, pointerType: "touch", isPrimary: true, clientX: centerX - 60, clientY: centerY + 10 });
  await canvas.dispatchEvent("pointermove", { pointerId: 4, pointerType: "touch", isPrimary: false, clientX: centerX + 60, clientY: centerY + 10 });
  await canvas.dispatchEvent("pointerup", { pointerId: 3, pointerType: "touch", isPrimary: true, clientX: centerX - 60, clientY: centerY + 10 });
  await canvas.dispatchEvent("pointerup", { pointerId: 4, pointerType: "touch", isPrimary: false, clientX: centerX + 60, clientY: centerY + 10 });
  expect(Number(await graph.getAttribute("data-graph-scale"))).toBeGreaterThan(beforeScale);
  await expect(page.locator(".workspace-center .workspace-tab-header.is-active .workspace-tab-header-inner-title")).toHaveText("Graph view");

  // A pinch invalidates the first tap's double-tap candidate. The next tap
  // selects only even when it lands within the normal 500ms window.
  const nodeAfterPinch = await graphNodePoint(graph, "Notes/Proof.md");
  await canvas.dispatchEvent("pointerdown", { pointerId: 5, pointerType: "touch", isPrimary: true, ...nodeAfterPinch });
  await canvas.dispatchEvent("pointerup", { pointerId: 5, pointerType: "touch", isPrimary: true, ...nodeAfterPinch });
  await expect(page.locator(".workspace-center .workspace-tab-header.is-active .workspace-tab-header-inner-title")).toHaveText("Graph view");
  await canvas.dispatchEvent("pointerdown", { pointerId: 6, pointerType: "touch", isPrimary: true, clientX: centerX - 25, clientY: centerY });
  await canvas.dispatchEvent("pointerdown", { pointerId: 7, pointerType: "touch", isPrimary: false, clientX: centerX + 25, clientY: centerY });
  await canvas.dispatchEvent("pointerup", { pointerId: 6, pointerType: "touch", isPrimary: true, clientX: centerX - 25, clientY: centerY });
  await canvas.dispatchEvent("pointerup", { pointerId: 7, pointerType: "touch", isPrimary: false, clientX: centerX + 25, clientY: centerY });
  const nodeAfterSecondPinch = await graphNodePoint(graph, "Notes/Proof.md");
  await canvas.dispatchEvent("pointerdown", { pointerId: 8, pointerType: "touch", isPrimary: true, ...nodeAfterSecondPinch });
  await canvas.dispatchEvent("pointerup", { pointerId: 8, pointerType: "touch", isPrimary: true, ...nodeAfterSecondPinch });
  await expect(page.locator(".workspace-center .workspace-tab-header.is-active .workspace-tab-header-inner-title")).toHaveText("Graph view");

  const searchButton = graph.getByRole("button", { name: "Search graph" });
  await searchButton.click();
  await page.getByRole("searchbox", { name: "Search graph nodes" }).fill("Orphan");
  await expect(graph).toHaveAttribute("data-graph-visible-count", "1");
  await page.keyboard.press("Escape");
  await expect(searchButton).toBeFocused();
  await searchButton.click();
  await page.getByRole("searchbox", { name: "Search graph nodes" }).fill("");
  await page.getByRole("button", { name: "Close search" }).click();

  const filter = graph.getByRole("button", { name: "Filter linked nodes" });
  await filter.click();
  await expect(graph).toHaveAttribute("data-graph-visible-count", "2");
  await filter.click();
  const group = graph.getByRole("button", { name: "Group by folder" });
  await group.click();
  await expect(group).toHaveAttribute("aria-pressed", "true");
  const local = graph.getByRole("button", { name: "Show local graph" });
  await local.click();
  await expect(graph).toHaveAttribute("data-graph-mode", "local");
  await expect(graph).toHaveAttribute("data-graph-visible-count", "2");
  await graph.getByRole("button", { name: "Relayout graph" }).click();
  await expect.poll(async () => graph.getAttribute("data-graph-node-positions")).not.toBeNull();
  await graph.getByRole("button", { name: "Fit graph" }).click();

  const nodeBeforeCancel = await graphNodePoint(graph, "Notes/Proof.md");
  await canvas.dispatchEvent("pointerdown", { pointerId: 80, pointerType: "touch", isPrimary: true, ...nodeBeforeCancel });
  await canvas.dispatchEvent("pointerup", { pointerId: 80, pointerType: "touch", isPrimary: true, ...nodeBeforeCancel });
  await canvas.dispatchEvent("pointerdown", { pointerId: 9, pointerType: "touch", isPrimary: true, ...empty });
  await expect(graph).toHaveAttribute("data-graph-gesture", "active");
  await canvas.dispatchEvent("pointercancel", { pointerId: 9, pointerType: "touch", isPrimary: true, ...empty });
  await expect(graph).toHaveAttribute("data-graph-gesture", "idle");
  await expect(graph).toHaveAttribute("data-graph-captured-pointers", "0");
  const nodeAfterCancel = await graphNodePoint(graph, "Notes/Proof.md");
  await canvas.dispatchEvent("pointerdown", { pointerId: 11, pointerType: "touch", isPrimary: true, ...nodeAfterCancel });
  await canvas.dispatchEvent("pointerup", { pointerId: 11, pointerType: "touch", isPrimary: true, ...nodeAfterCancel });
  await expect(page.locator(".workspace-center .workspace-tab-header.is-active .workspace-tab-header-inner-title")).toHaveText("Graph view");
  await canvas.dispatchEvent("pointerdown", { pointerId: 10, pointerType: "touch", isPrimary: true, ...empty });
  await page.evaluate(() => (window as any).__geodeMobileTest.background());
  await expect(graph).toHaveAttribute("data-graph-gesture", "idle");
  await expect(graph).toHaveAttribute("data-graph-captured-pointers", "0");
  await page.evaluate(() => (window as any).__geodeMobileTest.foreground());

  const nodeAfterBackground = await graphNodePoint(graph, "Notes/Proof.md");
  await canvas.dispatchEvent("pointerdown", { pointerId: 12, pointerType: "touch", isPrimary: true, ...nodeAfterBackground });
  await canvas.dispatchEvent("pointerup", { pointerId: 12, pointerType: "touch", isPrimary: true, ...nodeAfterBackground });
  await expect(page.locator(".workspace-center .workspace-tab-header.is-active .workspace-tab-header-inner-title")).toHaveText("Graph view");

  // At minimum zoom the touch-only target remains 44px wide. An offset just
  // outside it becomes an empty-space pan; desktop mouse hit testing is not used.
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("geode:graph-view:"))!;
    const state = JSON.parse(localStorage.getItem(key)!);
    state.scale = 0.1;
    state.panX = 0;
    state.panY = 0;
    state.selected = null;
    state.searchQuery = "Proof";
    localStorage.setItem(key, JSON.stringify(state));
  });
  await page.reload();
  await expect.poll(async () => graph.getAttribute("data-graph-node-positions")).not.toBeNull();
  const minInside = await graphNodePoint(graph, "Notes/Proof.md", 21.9);
  await canvas.dispatchEvent("pointerdown", { pointerId: 20, pointerType: "touch", isPrimary: true, ...minInside });
  await canvas.dispatchEvent("pointerup", { pointerId: 20, pointerType: "touch", isPrimary: true, ...minInside });
  await expect(graph).toHaveAttribute("data-graph-selected", "Notes/Proof.md");
  const minOutside = await graphNodePoint(graph, "Notes/Proof.md", 22.1);
  const minPan = Number(await graph.getAttribute("data-graph-pan-x"));
  await canvas.dispatchEvent("pointerdown", { pointerId: 21, pointerType: "touch", isPrimary: true, ...minOutside });
  await canvas.dispatchEvent("pointermove", { pointerId: 21, pointerType: "touch", isPrimary: true, clientX: minOutside.clientX + 12, clientY: minOutside.clientY });
  await canvas.dispatchEvent("pointerup", { pointerId: 21, pointerType: "touch", isPrimary: true, clientX: minOutside.clientX + 12, clientY: minOutside.clientY });
  expect(Number(await graph.getAttribute("data-graph-pan-x"))).toBeGreaterThan(minPan + 10);

  // At maximum zoom the visible node is larger than the minimum target; hit
  // testing follows that visual radius and still hands its outside to panning.
  await page.evaluate(() => {
    const graph = document.querySelector<HTMLElement>(".graph-view")!;
    const positions = JSON.parse(graph.dataset.graphNodePositions!) as Record<string, [number, number]>;
    const [x, y] = positions["Notes/Proof.md"];
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("geode:graph-view:"))!;
    const state = JSON.parse(localStorage.getItem(key)!);
    state.scale = 8;
    state.panX = -x * 8;
    state.panY = -y * 8;
    state.selected = null;
    localStorage.setItem(key, JSON.stringify(state));
  });
  await page.reload();
  await expect.poll(async () => graph.getAttribute("data-graph-node-positions")).not.toBeNull();
  const maxInside = await graphNodePoint(graph, "Notes/Proof.md", 40);
  await canvas.dispatchEvent("pointerdown", { pointerId: 22, pointerType: "touch", isPrimary: true, ...maxInside });
  await canvas.dispatchEvent("pointerup", { pointerId: 22, pointerType: "touch", isPrimary: true, ...maxInside });
  await expect(graph).toHaveAttribute("data-graph-selected", "Notes/Proof.md");
  const maxOutside = await graphNodePoint(graph, "Notes/Proof.md", 42);
  const maxPan = Number(await graph.getAttribute("data-graph-pan-x"));
  await canvas.dispatchEvent("pointerdown", { pointerId: 23, pointerType: "touch", isPrimary: true, ...maxOutside });
  await canvas.dispatchEvent("pointermove", { pointerId: 23, pointerType: "touch", isPrimary: true, clientX: maxOutside.clientX + 12, clientY: maxOutside.clientY });
  await canvas.dispatchEvent("pointerup", { pointerId: 23, pointerType: "touch", isPrimary: true, clientX: maxOutside.clientX + 12, clientY: maxOutside.clientY });
  expect(Number(await graph.getAttribute("data-graph-pan-x"))).toBeGreaterThan(maxPan + 10);

  await graph.getByRole("button", { name: "Search graph" }).click();
  await expect(page.getByRole("searchbox", { name: "Search graph nodes" })).toHaveValue("Proof");
  await page.getByRole("button", { name: "Close search" }).click();
  const persistedFilter = graph.getByRole("button", { name: "Filter linked nodes" });
  if (await persistedFilter.getAttribute("aria-pressed") !== "true") await persistedFilter.click();
  const persistedGroup = graph.getByRole("button", { name: "Group by folder" });
  if (await persistedGroup.getAttribute("aria-pressed") !== "true") await persistedGroup.click();
  const persistedLocal = graph.getByRole("button", { name: /Show (local|global) graph/ });
  if (await persistedLocal.getAttribute("aria-pressed") !== "true") await persistedLocal.click();

  const saved = await graph.evaluate((element) => ({
    panX: (element as HTMLElement).dataset.graphPanX,
    panY: (element as HTMLElement).dataset.graphPanY,
    scale: (element as HTMLElement).dataset.graphScale,
    selected: (element as HTMLElement).dataset.graphSelected,
    visible: (element as HTMLElement).dataset.graphVisibleCount,
  }));
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(graph).toHaveAttribute("data-graph-selected", saved.selected);
  expect(await page.evaluate(() => ({ scrollY, visualScale: visualViewport?.scale }))).toEqual({ scrollY: 0, visualScale: 1 });
  await page.waitForTimeout(400);
  await page.reload();
  await expect(graph).toBeVisible();
  await expect(graph).toHaveAttribute("data-graph-selected", saved.selected);
  await expect(graph).toHaveAttribute("data-graph-pan-x", saved.panX!);
  await expect(graph).toHaveAttribute("data-graph-pan-y", saved.panY!);
  await expect(graph).toHaveAttribute("data-graph-scale", saved.scale!);
  await expect(graph).toHaveAttribute("data-graph-visible-count", saved.visible!);
  await expect(graph.getByRole("button", { name: "Filter linked nodes" })).toHaveAttribute("aria-pressed", "true");
  await expect(graph.getByRole("button", { name: "Group by folder" })).toHaveAttribute("aria-pressed", "true");
  await expect(graph.getByRole("button", { name: "Show global graph" })).toHaveAttribute("aria-pressed", "true");
  await graph.getByRole("button", { name: "Search graph" }).click();
  await expect(page.getByRole("searchbox", { name: "Search graph nodes" })).toHaveValue("Proof");
});

test("@phone @tablet Canvas supports touch authoring, gestures, acknowledged saves, and conflict preservation", async ({ page }) => {
  test.setTimeout(90_000);
  await openExternalProofNote(page);
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Boards/Proof.canvas"), false);
  });
  const view = page.locator(".canvas-view");
  const surface = view.locator(".canvas-surface");
  const alpha = view.locator('.canvas-node[data-node-id="alpha"]');
  await expect(alpha).toBeVisible();
  await expect(view.locator(".canvas-node")).toHaveCount(2);

  for (const button of await view.locator(".canvas-toolbar button, .canvas-controls button").all()) {
    const box = await button.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(await button.getAttribute("aria-label")).toBeTruthy();
  }

  const center = async (node: Locator) => {
    const box = (await node.boundingBox())!;
    return { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  };
  let point = await center(alpha);
  await alpha.dispatchEvent("pointerdown", { pointerId: 101, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointerup", { pointerId: 101, pointerType: "touch", isPrimary: true, ...point });
  await expect(alpha).toHaveClass(/is-selected/);
  await expect(view.getByRole("button", { name: "Edit" })).toBeVisible();

  point = await center(alpha);
  await alpha.dispatchEvent("pointerdown", { pointerId: 102, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointermove", { pointerId: 102, pointerType: "touch", isPrimary: true, clientX: point.clientX + 30, clientY: point.clientY + 20 });
  await surface.dispatchEvent("pointerup", { pointerId: 102, pointerType: "touch", isPrimary: true, clientX: point.clientX + 30, clientY: point.clientY + 20 });
  await expect.poll(async () => JSON.parse(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).nodes.find((node: any) => node.id === "alpha"))
    .toMatchObject({ x: 70, y: 60 });
  await expect(view).toHaveAttribute("data-canvas-dirty", "false");

  const beforeCamera = await view.evaluate((element) => ({ panX: element.getAttribute("data-pan-x"), scale: element.getAttribute("data-scale") }));
  const surfaceBox = (await surface.boundingBox())!;
  const cx = surfaceBox.x + surfaceBox.width / 2;
  const cy = surfaceBox.y + surfaceBox.height / 2;
  await surface.dispatchEvent("pointerdown", { pointerId: 103, pointerType: "touch", isPrimary: true, clientX: cx - 30, clientY: cy });
  await surface.dispatchEvent("pointerdown", { pointerId: 104, pointerType: "touch", isPrimary: false, clientX: cx + 30, clientY: cy });
  await surface.dispatchEvent("pointermove", { pointerId: 103, pointerType: "touch", isPrimary: true, clientX: cx - 55, clientY: cy + 10 });
  await surface.dispatchEvent("pointermove", { pointerId: 104, pointerType: "touch", isPrimary: false, clientX: cx + 55, clientY: cy + 10 });
  await surface.dispatchEvent("pointerup", { pointerId: 103, pointerType: "touch", isPrimary: true, clientX: cx - 55, clientY: cy + 10 });
  await surface.dispatchEvent("pointerup", { pointerId: 104, pointerType: "touch", isPrimary: false, clientX: cx + 55, clientY: cy + 10 });
  expect(Number(await view.getAttribute("data-scale"))).toBeGreaterThan(Number(beforeCamera.scale));
  expect(await view.getAttribute("data-pan-x")).not.toBe(beforeCamera.panX);

  const persistedBeforeCancel = await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"));
  point = await center(alpha);
  await alpha.dispatchEvent("pointerdown", { pointerId: 105, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointermove", { pointerId: 105, pointerType: "touch", isPrimary: true, clientX: point.clientX + 45, clientY: point.clientY });
  await surface.dispatchEvent("pointercancel", { pointerId: 105, pointerType: "touch", isPrimary: true, clientX: point.clientX + 45, clientY: point.clientY });
  await expect(view).toHaveAttribute("data-canvas-captured-pointers", "0");
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).toBe(persistedBeforeCancel);
  await expect(alpha).toHaveCSS("left", "70px");

  point = await center(alpha);
  await alpha.dispatchEvent("pointerdown", { pointerId: 1050, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointermove", { pointerId: 1050, pointerType: "touch", isPrimary: true, clientX: point.clientX + 30, clientY: point.clientY + 10 });
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.height, height: viewport.width });
  await page.evaluate(() => (window as any).__geodeMobileTest.background());
  await expect(view).toHaveAttribute("data-canvas-captured-pointers", "0");
  await expect(alpha).toHaveCSS("left", "70px");
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).toBe(persistedBeforeCancel);
  await page.evaluate(() => (window as any).__geodeMobileTest.foreground());

  await view.getByRole("button", { name: "Edit" }).click();
  const editor = view.locator(".canvas-node-text-editor");
  await editor.fill("Alpha edited on touch");
  const editorBox = (await editor.boundingBox())!;
  expect(editorBox.y + editorBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await editor.press("ControlOrMeta+Enter");
  await expect.poll(async () => JSON.parse(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).nodes.find((node: any) => node.id === "alpha")?.text)
    .toBe("Alpha edited on touch");

  await view.getByRole("button", { name: "Select all cards" }).click();
  await view.getByRole("button", { name: "Connect selected nodes" }).click();
  await expect.poll(async () => JSON.parse(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).edges.length).toBe(1);
  const beforeReconnectCancel = await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"));
  const edgeHit = view.locator('.canvas-edge-hit[data-edge-id="edge-1"]');
  await edgeHit.dispatchEvent("pointerdown", { pointerId: 601, pointerType: "touch", isPrimary: true, button: 0 });
  const endpoint = view.locator('.canvas-edge-endpoint-touch-hit[data-edge-id="edge-1"][data-endpoint="target"]');
  const endpointBox = (await endpoint.boundingBox())!;
  expect(endpointBox.width).toBeGreaterThanOrEqual(44);
  expect(endpointBox.height).toBeGreaterThanOrEqual(44);
  await endpoint.dispatchEvent("pointerdown", { pointerId: 602, pointerType: "touch", isPrimary: true, button: 0, clientX: endpointBox.x + endpointBox.width / 2, clientY: endpointBox.y + endpointBox.height / 2 });
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 602, pointerType: "touch" })));
  await expect(view).not.toHaveClass(/is-connecting/);
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).toBe(beforeReconnectCancel);
  const directHandle = view.locator('.canvas-node[data-node-id="alpha"] .canvas-node-connection-handle[data-side="right"]');
  const directHandleBox = (await directHandle.boundingBox())!;
  await directHandle.dispatchEvent("pointerdown", {
    pointerId: 605,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: directHandleBox.x + directHandleBox.width / 2,
    clientY: directHandleBox.y + directHandleBox.height / 2,
  });
  await expect(view).toHaveClass(/is-connecting/);
  await page.evaluate(() => (window as any).__geodeMobileTest.background());
  await expect(view).not.toHaveClass(/is-connecting/);
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).toBe(beforeReconnectCancel);
  await page.evaluate(() => (window as any).__geodeMobileTest.foreground());
  const serializedBeforeZoom = await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"));
  for (let index = 0; index < 20; index += 1) await view.getByRole("button", { name: "Zoom out" }).click();
  await expect(view).toHaveAttribute("data-scale", "0.2");
  for (const target of [
    view.locator('.canvas-edge-endpoint-touch-hit[data-edge-id="edge-1"][data-endpoint="target"]'),
    view.locator('.canvas-node[data-node-id="alpha"] .canvas-node-connection-touch-hit[data-side="right"]'),
    view.locator('.canvas-node[data-node-id="alpha"] .canvas-node-resize-touch-hit'),
  ]) {
    const box = (await target.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  for (let index = 0; index < 40; index += 1) await view.getByRole("button", { name: "Zoom in" }).click();
  await expect(view).toHaveAttribute("data-scale", "4");
  for (const target of [
    view.locator('.canvas-edge-endpoint-touch-hit[data-edge-id="edge-1"][data-endpoint="target"]'),
    view.locator('.canvas-node[data-node-id="alpha"] .canvas-node-connection-touch-hit[data-side="right"]'),
    view.locator('.canvas-node[data-node-id="alpha"] .canvas-node-resize-touch-hit'),
  ]) {
    const box = (await target.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await view.getByRole("button", { name: "Reset zoom" }).click();
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).toBe(serializedBeforeZoom);
  point = await center(alpha);
  await alpha.dispatchEvent("pointerdown", { pointerId: 106, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointerup", { pointerId: 106, pointerType: "touch", isPrimary: true, ...point });
  await view.getByRole("button", { name: "Set color" }).click();
  await view.getByRole("button", { name: "Color 1" }).click();
  await expect.poll(async () => JSON.parse(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).nodes.find((node: any) => node.id === "alpha")?.color).toBe("1");
  await view.getByRole("button", { name: "Duplicate" }).click();
  await expect(view.locator(".canvas-node")).toHaveCount(3);
  await view.getByRole("button", { name: "Remove" }).click();
  await expect(view.locator(".canvas-node")).toHaveCount(2);

  await view.getByRole("button", { name: "Add text card" }).click();
  await view.locator(".canvas-node-text-editor").fill("Created by touch");
  await view.locator(".canvas-node-text-editor").press("ControlOrMeta+Enter");
  await expect.poll(async () => JSON.parse(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).nodes.length).toBe(3);
  await view.locator('.canvas-edge-hit[data-edge-id="edge-1"]').dispatchEvent("pointerdown", { pointerId: 603, pointerType: "touch", isPrimary: true, button: 0 });
  const reconnect = view.locator('.canvas-edge-endpoint-touch-hit[data-edge-id="edge-1"][data-endpoint="target"]');
  const reconnectBox = (await reconnect.boundingBox())!;
  const createdId = await page.evaluate(async () => JSON.parse(await window.hostServices!.vaultFiles.read("Boards/Proof.canvas")).nodes.at(-1).id);
  const targetHandle = view.locator(`.canvas-node[data-node-id="${createdId}"] .canvas-node-connection-handle[data-side="left"]`);
  const targetBox = (await targetHandle.boundingBox())!;
  await reconnect.dispatchEvent("pointerdown", { pointerId: 604, pointerType: "touch", isPrimary: true, button: 0, clientX: reconnectBox.x + reconnectBox.width / 2, clientY: reconnectBox.y + reconnectBox.height / 2 });
  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 604, pointerType: "touch", clientX: x, clientY: y }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 604, pointerType: "touch", clientX: x, clientY: y }));
  }, { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 });
  await expect.poll(async () => JSON.parse(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).edges[0].toNode).toBe(createdId);
  await view.getByRole("button", { name: "Add note from vault" }).click();
  await page.getByPlaceholder("Search notes…").fill("Linked");
  await page.getByText("Notes/Linked.md", { exact: true }).click();
  await expect.poll(async () => JSON.parse(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).nodes.some((node: any) => node.type === "file" && node.file === "Notes/Linked.md")).toBe(true);
  await view.getByRole("button", { name: "Undo Canvas change" }).click();
  await expect.poll(async () => JSON.parse(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).nodes.length).toBe(3);
  await view.getByRole("button", { name: "Redo Canvas change" }).click();
  await expect.poll(async () => JSON.parse(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).nodes.length).toBe(4);

  const beforeFailedDrag = await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"));
  await page.evaluate(() => { (window as any).__geodeMobileTest.failNextWrite = true; });
  point = await center(alpha);
  await alpha.dispatchEvent("pointerdown", { pointerId: 1007, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointerup", { pointerId: 1007, pointerType: "touch", isPrimary: true, ...point });
  await alpha.dispatchEvent("pointerdown", { pointerId: 107, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointermove", { pointerId: 107, pointerType: "touch", isPrimary: true, clientX: point.clientX + 24, clientY: point.clientY });
  await surface.dispatchEvent("pointerup", { pointerId: 107, pointerType: "touch", isPrimary: true, clientX: point.clientX + 24, clientY: point.clientY });
  await expect(view).toHaveAttribute("data-canvas-save-error", /Injected browser write failure/);
  await expect(view.getByRole("alert")).toContainText("Canvas save failed");
  await expect(view.getByRole("button", { name: "Retry Canvas save" })).toBeVisible();
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).toBe(beforeFailedDrag);
  await view.getByRole("button", { name: "Retry Canvas save" }).click();
  await expect.poll(() => view.getAttribute("data-canvas-dirty")).toBe("false");
  await expect(view.getByRole("status")).toContainText("Canvas saved");
  await expect(view.getByRole("button", { name: "Retry Canvas save" })).toHaveCount(0);

  const provider = JSON.parse(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas")));
  provider.nodes.find((node: any) => node.id === "beta").text = "External provider version";
  const conflictNodeId = provider.nodes.at(-1).id as string;
  const conflictNode = view.locator(`.canvas-node[data-node-id="${conflictNodeId}"]`);
  point = await center(conflictNode);
  await conflictNode.dispatchEvent("pointerdown", { pointerId: 1008, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointerup", { pointerId: 1008, pointerType: "touch", isPrimary: true, ...point });
  await expect(conflictNode).toHaveClass(/is-selected/);
  await conflictNode.dispatchEvent("pointerdown", { pointerId: 108, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointermove", { pointerId: 108, pointerType: "touch", isPrimary: true, clientX: point.clientX + 28, clientY: point.clientY + 12 });
  await expect.poll(async () => parseFloat(await conflictNode.evaluate((element) => (element as HTMLElement).style.left)))
    .not.toBe(provider.nodes.find((node: any) => node.id === conflictNodeId).x);
  await page.evaluate((text) => {
    (window as any).__geodeMobileTest.externalWrite("Boards/Proof.canvas", text);
    (window as any).__geodeMobileTest.foreground();
  }, JSON.stringify(provider));
  await expect(view.locator(".canvas-conflict-state")).toContainText("both preserved");
  await expect.poll(async () => JSON.parse(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).nodes.find((node: any) => node.id === "beta")?.text)
    .toBe("External provider version");
  const conflictPath = await view.getAttribute("data-canvas-conflict-path");
  expect(conflictPath).toContain("Geode conflict");
  const conflict = JSON.parse(await page.evaluate((path) => window.hostServices!.vaultFiles.read(path!), conflictPath));
  expect(conflict.nodes.find((node: any) => node.id === conflictNodeId).x).not.toBe(provider.nodes.find((node: any) => node.id === conflictNodeId).x);
  expect(await page.evaluate(() => ({ scrollY, visualScale: visualViewport?.scale }))).toEqual({ scrollY: 0, visualScale: 1 });

  const beforeDisposeReconnect = await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"));
  const disposeEndpoint = view.locator('.canvas-edge-endpoint-touch-hit[data-edge-id="edge-1"][data-endpoint="target"]');
  const disposeEndpointBox = (await disposeEndpoint.boundingBox())!;
  await disposeEndpoint.dispatchEvent("pointerdown", {
    pointerId: 606,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: disposeEndpointBox.x + disposeEndpointBox.width / 2,
    clientY: disposeEndpointBox.y + disposeEndpointBox.height / 2,
  });
  await expect(view).toHaveClass(/is-connecting/);
  await page.evaluate(async () => {
    const leaf = (window as any).app.workspace.getLeavesOfType("canvas")[0];
    await leaf.view.onClose();
  });
  await expect(view).not.toHaveClass(/is-connecting/);
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).toBe(beforeDisposeReconnect);

  await page.setViewportSize({ width: 844, height: 390 });
  await page.reload();
  await expect(view.locator(".canvas-node")).toHaveCount(4);
  await expect(view.locator('.canvas-node[data-node-id="beta"]')).toContainText("External provider version");
});

test("@phone clean external Canvas delete detaches its leaf without recreating the path", async ({ page }) => {
  await openExternalProofNote(page);
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Boards/Proof.canvas"), false);
    (window as any).__geodeMobileTest.externalDelete("Boards/Proof.canvas");
    (window as any).__geodeMobileTest.foreground();
    await app.reconcileVault("manual");
  });
  await expect.poll(() => page.locator(".canvas-view").count()).toBe(0);
  await expect.poll(() => page.evaluate(() => window.hostServices!.vaultFiles.exists("Boards/Proof.canvas"))).toBe(false);
  expect(await page.evaluate(() => (window as any).app.vault.getAbstractFileByPath("Boards/Proof.canvas"))).toBeNull();
});

test("@phone dirty in-gesture folder delete preserves a read-only Canvas conflict and never recreates its path", async ({ page }) => {
  await openExternalProofNote(page);
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Boards/Proof.canvas"), false);
  });
  const view = page.locator(".canvas-view");
  const surface = view.locator(".canvas-surface");
  const alpha = view.locator('.canvas-node[data-node-id="alpha"]');
  const box = (await alpha.boundingBox())!;
  const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await alpha.dispatchEvent("pointerdown", { pointerId: 301, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointerup", { pointerId: 301, pointerType: "touch", isPrimary: true, ...point });
  await alpha.dispatchEvent("pointerdown", { pointerId: 302, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointermove", { pointerId: 302, pointerType: "touch", isPrimary: true, clientX: point.clientX + 30, clientY: point.clientY + 12 });
  await page.evaluate(async () => {
    (window as any).__geodeMobileTest.externalDeleteFolder("Boards");
    (window as any).__geodeMobileTest.foreground();
    await (window as any).app.reconcileVault("manual");
  });
  await expect(view.locator(".canvas-conflict-state")).toContainText("both preserved");
  await expect(surface).toHaveAttribute("inert", "");
  const conflictPath = await view.getAttribute("data-canvas-conflict-path");
  expect(conflictPath).toContain("Geode conflict");
  const local = JSON.parse(await page.evaluate((path) => window.hostServices!.vaultFiles.read(path!), conflictPath));
  expect(local.nodes.find((node: any) => node.id === "alpha").x).toBeGreaterThan(40);
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.exists("Boards/Proof.canvas"))).toBe(false);
  await page.waitForTimeout(1_200);
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.exists("Boards/Proof.canvas"))).toBe(false);
});

test("@phone external file delete cancels a dirty edge reconnect before conflict capture", async ({ page }) => {
  await openExternalProofNote(page);
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Boards/Proof.canvas"), false);
  });
  const view = page.locator(".canvas-view");
  const surface = view.locator(".canvas-surface");
  await view.getByRole("button", { name: "Select all cards" }).click();
  await view.getByRole("button", { name: "Connect selected nodes" }).click();
  await expect.poll(async () => JSON.parse(await page.evaluate(() => window.hostServices!.vaultFiles.read("Boards/Proof.canvas"))).edges.length).toBe(1);
  const alpha = view.locator('.canvas-node[data-node-id="alpha"]');
  const alphaBox = (await alpha.boundingBox())!;
  const point = { clientX: alphaBox.x + alphaBox.width / 2, clientY: alphaBox.y + alphaBox.height / 2 };
  await alpha.dispatchEvent("pointerdown", { pointerId: 701, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointerup", { pointerId: 701, pointerType: "touch", isPrimary: true, ...point });
  await alpha.dispatchEvent("pointerdown", { pointerId: 702, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointermove", { pointerId: 702, pointerType: "touch", isPrimary: true, clientX: point.clientX + 30, clientY: point.clientY + 10 });
  const expectedConflict = await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("canvas")[0].view.getText());
  await view.locator('.canvas-edge-hit[data-edge-id="edge-1"]').dispatchEvent("pointerdown", { pointerId: 703, pointerType: "touch", isPrimary: true, button: 0 });
  const endpoint = view.locator('.canvas-edge-endpoint-touch-hit[data-edge-id="edge-1"][data-endpoint="target"]');
  const endpointBox = (await endpoint.boundingBox())!;
  await endpoint.dispatchEvent("pointerdown", { pointerId: 704, pointerType: "touch", isPrimary: true, button: 0, clientX: endpointBox.x + endpointBox.width / 2, clientY: endpointBox.y + endpointBox.height / 2 });
  await expect(view).toHaveClass(/is-connecting/);
  await page.evaluate(async () => {
    (window as any).__geodeMobileTest.externalDelete("Boards/Proof.canvas");
    (window as any).__geodeMobileTest.foreground();
    await (window as any).app.reconcileVault("manual");
  });
  await expect(view).not.toHaveClass(/is-connecting/);
  await expect(surface).toHaveAttribute("inert", "");
  const conflictPath = await view.getAttribute("data-canvas-conflict-path");
  const beforeLateUp = await page.evaluate((path) => window.hostServices!.vaultFiles.read(path!), conflictPath);
  expect(beforeLateUp).toBe(expectedConflict);
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 704, pointerType: "touch", clientX: 0, clientY: 0 })));
  expect(await page.evaluate((path) => window.hostServices!.vaultFiles.read(path!), conflictPath)).toBe(beforeLateUp);
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.exists("Boards/Proof.canvas"))).toBe(false);
});

test("@phone external folder delete cancels a dirty new connection before conflict capture", async ({ page }) => {
  await openExternalProofNote(page);
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Boards/Proof.canvas"), false);
  });
  const view = page.locator(".canvas-view");
  const surface = view.locator(".canvas-surface");
  const alpha = view.locator('.canvas-node[data-node-id="alpha"]');
  const alphaBox = (await alpha.boundingBox())!;
  const point = { clientX: alphaBox.x + alphaBox.width / 2, clientY: alphaBox.y + alphaBox.height / 2 };
  await alpha.dispatchEvent("pointerdown", { pointerId: 711, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointerup", { pointerId: 711, pointerType: "touch", isPrimary: true, ...point });
  await alpha.dispatchEvent("pointerdown", { pointerId: 712, pointerType: "touch", isPrimary: true, ...point });
  await surface.dispatchEvent("pointermove", { pointerId: 712, pointerType: "touch", isPrimary: true, clientX: point.clientX + 25, clientY: point.clientY + 10 });
  const expectedConflict = await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("canvas")[0].view.getText());
  const handle = view.locator('.canvas-node[data-node-id="alpha"] .canvas-node-connection-handle[data-side="right"]');
  const handleBox = (await handle.boundingBox())!;
  await handle.dispatchEvent("pointerdown", { pointerId: 713, pointerType: "touch", isPrimary: true, button: 0, clientX: handleBox.x + handleBox.width / 2, clientY: handleBox.y + handleBox.height / 2 });
  await expect(view).toHaveClass(/is-connecting/);
  await page.evaluate(async () => {
    (window as any).__geodeMobileTest.externalDeleteFolder("Boards");
    (window as any).__geodeMobileTest.foreground();
    await (window as any).app.reconcileVault("manual");
  });
  await expect(view).not.toHaveClass(/is-connecting/);
  await expect(surface).toHaveAttribute("inert", "");
  const conflictPath = await view.getAttribute("data-canvas-conflict-path");
  const beforeLateUp = await page.evaluate((path) => window.hostServices!.vaultFiles.read(path!), conflictPath);
  expect(beforeLateUp).toBe(expectedConflict);
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 713, pointerType: "touch", clientX: 0, clientY: 0 })));
  expect(await page.evaluate((path) => window.hostServices!.vaultFiles.read(path!), conflictPath)).toBe(beforeLateUp);
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.exists("Boards/Proof.canvas"))).toBe(false);
});

test("@phone @tablet Bases supports touch table editing, save retry, controls, Cards, and reload", async ({ page }) => {
  test.setTimeout(90_000);
  await openMobileBase(page);
  const view = page.locator(".base-view");
  const table = view.locator(".bases-table-container");
  for (const control of await view.locator(".bases-toolbar button, .bases-toolbar select, .bases-mobile-cell-actions button").all()) {
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  const beforeScroll = await table.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
  const box = (await table.boundingBox())!;
  await table.dispatchEvent("pointerdown", { pointerId: 801, pointerType: "touch", isPrimary: true, clientX: box.x + 250, clientY: box.y + 120 });
  await table.dispatchEvent("pointermove", { pointerId: 801, pointerType: "touch", isPrimary: true, clientX: box.x + 80, clientY: box.y + 125 });
  await table.dispatchEvent("pointerup", { pointerId: 801, pointerType: "touch", isPrimary: true, clientX: box.x + 80, clientY: box.y + 125 });
  expect((await table.evaluate((element) => element.scrollLeft))).toBeGreaterThan(beforeScroll.left);
  await expect(view.locator(".bases-cell.is-selected")).toHaveCount(0);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  const initialViewport = page.viewportSize()!;
  await page.setViewportSize({ width: initialViewport.width, height: 320 });
  const compactBox = (await table.boundingBox())!;
  await table.dispatchEvent("pointerdown", { pointerId: 805, pointerType: "touch", isPrimary: true, clientX: compactBox.x + 120, clientY: compactBox.y + 180 });
  await table.dispatchEvent("pointermove", { pointerId: 805, pointerType: "touch", isPrimary: true, clientX: compactBox.x + 125, clientY: compactBox.y + 40 });
  await table.dispatchEvent("pointerup", { pointerId: 805, pointerType: "touch", isPrimary: true, clientX: compactBox.x + 125, clientY: compactBox.y + 40 });
  expect(await table.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.setViewportSize(initialViewport);

  const headers = await view.locator(".bases-table thead th").allInnerTexts();
  const priorityIndex = headers.indexOf("note.priority");
  const priority = view.locator(".bases-data-row", { hasText: "Gamma.md" }).locator(".bases-cell").nth(priorityIndex);
  await touchTap(priority, 802);
  await view.getByRole("button", { name: "Edit selected cell" }).click();
  const input = priority.locator(".bases-cell-input");
  await input.fill("5");
  await expect(view.getByRole("button", { name: "Save cell edit" })).toBeVisible();
  const inputBox = (await input.boundingBox())!;
  expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(await page.evaluate(() => visualViewport?.height ?? innerHeight));
  await view.getByRole("button", { name: "Save cell edit" }).click();
  await expect(view.getByRole("status")).toContainText("Base saved");
  await expect.poll(() => page.evaluate(() => window.hostServices!.vaultFiles.read("Tasks/Gamma.md"))).toContain("priority: 5");

  await touchTap(priority, 806);
  await view.getByRole("button", { name: "Edit selected cell" }).click();
  await priority.locator(".bases-cell-input").fill("6");
  await page.evaluate(() => (window as any).__geodeMobileTest.background());
  await expect(priority.locator(".bases-cell-input")).toHaveValue("6");
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Tasks/Gamma.md"))).toContain("priority: 5");
  await page.evaluate(() => (window as any).__geodeMobileTest.foreground());
  await view.getByRole("button", { name: "Cancel cell edit" }).click();
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Tasks/Gamma.md"))).toContain("priority: 5");

  await touchTap(priority, 803);
  await view.getByRole("button", { name: "Edit selected cell" }).click();
  await priority.locator(".bases-cell-input").fill("7");
  await page.evaluate(() => { (window as any).__geodeMobileTest.failNextWrite = true; });
  await view.getByRole("button", { name: "Save cell edit" }).click();
  await expect(view.getByRole("alert")).toContainText("Base save failed");
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Tasks/Gamma.md"))).toContain("priority: 5");
  await view.getByRole("button", { name: "Retry Base save" }).click();
  await expect.poll(() => page.evaluate(() => window.hostServices!.vaultFiles.read("Tasks/Gamma.md"))).toContain("priority: 7");
  await expect(view.locator(".bases-mobile-editor-actions")).toHaveCount(0);
  const betaPriority = view.locator(".bases-data-row", { hasText: "Beta.md" }).locator(".bases-cell").nth(priorityIndex);
  await touchTap(betaPriority, 807);
  await view.getByRole("button", { name: "Edit selected cell" }).click();
  await betaPriority.locator(".bases-cell-input").fill("8");
  await view.getByRole("button", { name: "Save cell edit" }).click();
  await expect.poll(() => page.evaluate(() => window.hostServices!.vaultFiles.read("Tasks/Beta.md"))).toContain("priority: 8");

  await view.getByRole("button", { name: "Sort" }).click();
  let panel = page.locator(".bases-sort-panel");
  await panel.getByRole("button", { name: "+ Add sort" }).click();
  await panel.locator(".bases-sort-prop").first().selectOption("note.priority");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await view.locator(".bases-data-row .bases-cell:first-child").allInnerTexts()).filter((name) => /Alpha|Beta|Gamma/.test(name)))
    .toEqual(["Alpha.md", "Gamma.md", "Beta.md"]);

  await view.getByRole("button", { name: "Filter" }).click();
  panel = page.locator(".bases-filter-panel");
  const scope = panel.locator(".bases-filter-scope").nth(1);
  await scope.getByRole("button", { name: "+ Condition" }).click();
  await scope.locator(".bases-filter-prop").fill("note.status");
  await scope.locator(".bases-filter-prop").press("Tab");
  await scope.locator(".bases-filter-value").fill("Done");
  await scope.locator(".bases-filter-value").press("Tab");
  await page.keyboard.press("Escape");
  await expect(view.locator(".bases-data-row")).toHaveCount(1);
  await expect(view.locator(".bases-data-row")).toContainText("Gamma.md");
  await view.getByRole("button", { name: "Filter" }).click();
  await page.locator(".bases-filter-panel").getByTitle("Remove condition").click();
  await page.keyboard.press("Escape");
  await expect(view.locator(".bases-data-row")).toHaveCount(6);

  await view.getByRole("button", { name: "Properties" }).click();
  panel = page.locator(".bases-properties-panel");
  const ownerRow = panel.locator(".bases-properties-row", { hasText: "note.owner" });
  await ownerRow.locator('input[type="checkbox"]').click();
  await page.keyboard.press("Escape");
  await expect(view.locator(".bases-table thead")).not.toContainText("note.owner");
  await view.getByRole("button", { name: "Properties" }).click();
  const restoredOwner = page.locator(".bases-properties-panel .bases-properties-row", { hasText: "note.owner" }).locator('input[type="checkbox"]');
  await restoredOwner.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await restoredOwner.click();
  await page.keyboard.press("Escape");
  await expect(view.locator(".bases-table thead")).toContainText("note.owner");

  for (const name of ["Sort", "Filter", "Properties"]) {
    await view.getByRole("button", { name }).click();
    panel = page.locator(".bases-panel");
    const panelBox = (await panel.boundingBox())!;
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    for (const control of await panel.locator("button, input, select").all()) {
      if (!(await control.isVisible())) continue;
      const controlBox = await control.boundingBox();
      expect(controlBox?.width).toBeGreaterThanOrEqual(44);
      expect(controlBox?.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press("Escape");
  }
  await view.locator(".bases-toolbar-search").fill("Gamma");
  await expect(view.locator(".bases-data-row")).toHaveCount(1);
  await view.locator(".bases-toolbar-search").fill("");
  await view.locator(".bases-view-btn").click();
  await page.getByText("Cards", { exact: true }).click();
  await expect(view.locator(".bases-card")).toHaveCount(6);
  const gammaCard = view.locator(".bases-card", { hasText: "Gamma" });
  const gammaBox = (await gammaCard.boundingBox())!;
  await gammaCard.dispatchEvent("pointerdown", { pointerId: 804, pointerType: "touch", isPrimary: true, clientX: gammaBox.x + 20, clientY: gammaBox.y + 20 });
  await gammaCard.dispatchEvent("pointermove", { pointerId: 804, pointerType: "touch", isPrimary: true, clientX: gammaBox.x + 20, clientY: gammaBox.y + 50 });
  await gammaCard.dispatchEvent("pointerup", { pointerId: 804, pointerType: "touch", isPrimary: true, clientX: gammaBox.x + 20, clientY: gammaBox.y + 50 });
  await expect(view.locator(".bases-card.is-selected")).toHaveCount(0);
  await touchTap(gammaCard, 808);
  await expect(gammaCard).toHaveClass(/is-selected/);
  await expect(gammaCard).toHaveAttribute("aria-selected", "true");
  await expect(view.getByRole("button", { name: "Open selected card" })).toBeVisible();
  await expect(view.getByRole("button", { name: "Edit selected card" })).toBeVisible();
  for (const action of await view.locator(".bases-mobile-card-actions button").all()) {
    const actionBox = await action.boundingBox();
    expect(actionBox?.width).toBeGreaterThanOrEqual(44);
    expect(actionBox?.height).toBeGreaterThanOrEqual(44);
  }
  const alphaCard = view.locator(".bases-card", { hasText: "Alpha" });
  await alphaCard.focus();
  await alphaCard.press("Enter");
  await expect(alphaCard).toHaveAttribute("aria-selected", "true");
  const betaCard = view.locator(".bases-card", { hasText: "Beta" });
  await betaCard.click();
  await expect(betaCard).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 844, height: 390 });
  await page.reload();
  await expect(view.locator(".bases-cards-container")).toBeVisible();
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Tasks/Gamma.md"))).toContain("priority: 7");
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Tasks/Beta.md"))).toContain("priority: 8");
  expect(await page.evaluate(() => ({ scrollY, visualScale: visualViewport?.scale }))).toEqual({ scrollY: 0, visualScale: 1 });
});

test("@phone Bases preserves a dirty cell draft when provider reconciliation changes its note", async ({ page }) => {
  await openMobileBase(page);
  const view = page.locator(".base-view");
  const headers = await view.locator(".bases-table thead th").allInnerTexts();
  const statusIndex = headers.indexOf("note.status");
  const status = view.locator(".bases-data-row", { hasText: "Alpha.md" }).locator(".bases-cell").nth(statusIndex);
  await touchTap(status, 811);
  await view.getByRole("button", { name: "Edit selected cell" }).click();
  await status.locator(".bases-cell-input").fill("Local draft");
  await page.evaluate(async () => {
    (window as any).__geodeMobileTest.externalWrite("Tasks/Alpha.md", "---\nstatus: Provider version\npriority: 1\nowner: Ada\n---\nAlpha body\n");
    (window as any).__geodeMobileTest.foreground();
    await (window as any).app.reconcileVault("manual");
  });
  await expect(view.locator(".bases-conflict-state")).toContainText("both preserved");
  await expect(view.locator(".base-view-body")).toHaveAttribute("inert", "");
  const conflictPath = await view.getAttribute("data-bases-conflict-path");
  expect(conflictPath).toContain("Geode conflict");
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Tasks/Alpha.md"))).toContain("Provider version");
  expect(await page.evaluate((path) => window.hostServices!.vaultFiles.read(path!), conflictPath)).toContain("Local draft");
});

test("@phone Bases preserves a dirty cell draft when its provider folder is deleted", async ({ page }) => {
  await openMobileBase(page);
  const view = page.locator(".base-view");
  const headers = await view.locator(".bases-table thead th").allInnerTexts();
  const statusIndex = headers.indexOf("note.status");
  const status = view.locator(".bases-data-row", { hasText: "Alpha.md" }).locator(".bases-cell").nth(statusIndex);
  await touchTap(status, 821);
  await view.getByRole("button", { name: "Edit selected cell" }).click();
  await status.locator(".bases-cell-input").fill("Local deleted-folder draft");
  await page.evaluate(async () => {
    (window as any).__geodeMobileTest.externalDeleteFolder("Tasks");
    await (window as any).app.reconcileVault("manual");
  });
  await expect(view.locator(".bases-conflict-state")).toContainText("both preserved");
  await expect(view.locator(".base-view-body")).toHaveAttribute("inert", "");
  const conflictPath = await view.getAttribute("data-bases-conflict-path");
  expect(conflictPath).toContain("Geode conflict");
  expect(await page.evaluate((path) => window.hostServices!.vaultFiles.read(path!), conflictPath)).toContain("Local deleted-folder draft");
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.exists("Tasks/Alpha.md"))).toBe(false);
  expect(await page.evaluate(() => (window as any).app.vault.getAbstractFileByPath("Tasks/Alpha.md"))).toBeNull();
  await page.waitForTimeout(1_200);
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.exists("Tasks/Alpha.md"))).toBe(false);
});

test("@phone Bases bounds large mobile Table and Cards result DOM", async ({ page }) => {
  await openExternalProofNote(page);
  await page.evaluate(async () => {
    const host = window.hostServices!.vaultFiles;
    await host.mkdir("Bulk");
    await host.write("Assets/pixel.png", "bounded-cover-bytes");
    await Promise.all(Array.from({ length: 205 }, (_, index) => host.write(`Bulk/Row-${String(index).padStart(3, "0")}.md`, `---\nrank: ${index}\nbucket: group-${index}\ncover: "[[Assets/pixel.png]]"\n---\n`)));
    await host.write("Views/Large.base", "views:\n  - type: table\n    name: Table\n    order: [file.name, note.rank]\n  - type: cards\n    name: Cards\n    image: note.cover\n    groupBy:\n      property: note.bucket\n      direction: ASC\n    order: [file.name, note.rank]\n");
    const app = (window as any).app;
    await app.reconcileVault("manual");
    await app.openFile(app.vault.getFileByPath("Views/Large.base"), false);
  });
  const view = page.locator(".base-view");
  await expect(view.locator(".bases-data-row")).toHaveCount(200);
  await expect(view.locator(".bases-table-container > .bases-result-limit")).toContainText("Showing 200 of 208 results");
  await page.evaluate(() => {
    const original = URL.createObjectURL.bind(URL);
    (window as any).__basesBlobLoads = 0;
    URL.createObjectURL = (blob: Blob) => {
      (window as any).__basesBlobLoads += 1;
      return original(blob);
    };
  });
  await view.locator(".bases-view-btn").click();
  await page.getByText("Cards", { exact: true }).click();
  await expect(view.locator(".bases-card")).toHaveCount(200);
  await expect(view.locator(".bases-cards-container > .bases-result-limit")).toHaveCount(1);
  await expect(view.locator(".bases-cards-container > .bases-result-limit")).toContainText("Showing 200 of 208 results");
  expect(await view.locator(".bases-card-cover-img").count()).toBeLessThanOrEqual(200);
  await expect.poll(() => page.evaluate(() => (window as any).__basesBlobLoads)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__basesBlobLoads)).toBeLessThanOrEqual(200);
});

test("@phone opening another Base in the same leaf clears conflict and suspension state", async ({ page }) => {
  await openMobileBase(page);
  const view = page.locator(".base-view");
  const headers = await view.locator(".bases-table thead th").allInnerTexts();
  const statusIndex = headers.indexOf("note.status");
  const status = view.locator(".bases-data-row", { hasText: "Alpha.md" }).locator(".bases-cell").nth(statusIndex);
  await touchTap(status, 831);
  await view.getByRole("button", { name: "Edit selected cell" }).click();
  await status.locator(".bases-cell-input").fill("Base A recovery");
  await page.evaluate(async () => {
    (window as any).__geodeMobileTest.externalWrite("Tasks/Alpha.md", "---\nstatus: Provider A\npriority: 1\nowner: Ada\n---\nAlpha body\n");
    await (window as any).app.reconcileVault("manual");
  });
  const recoveryPath = await view.getAttribute("data-bases-conflict-path");
  expect(await page.evaluate((path) => window.hostServices!.vaultFiles.read(path!), recoveryPath)).toContain("Base A recovery");

  await page.evaluate(async () => {
    const host = window.hostServices!.vaultFiles;
    await host.write("Views/Second.base", "views:\n  - type: table\n    name: Table\n    order: [file.name, note.status, note.priority, note.owner]\n  - type: cards\n    name: Cards\n    order: [file.name, note.status]\n");
    const app = (window as any).app;
    await app.reconcileVault("manual");
    const leaf = app.workspace.getLeavesOfType("base")[0];
    await leaf.setViewState({ type: "base", state: { file: "Views/Second.base" } });
  });
  await expect(view.locator(".bases-conflict-state")).toHaveCount(0);
  await expect(view).not.toHaveAttribute("data-bases-conflict-path");
  await expect(view.locator(".base-view-body")).not.toHaveAttribute("inert", "");

  await view.getByRole("button", { name: "Sort" }).click();
  let panel = page.locator(".bases-sort-panel");
  await panel.getByRole("button", { name: "+ Add sort" }).click();
  await panel.locator(".bases-sort-prop").first().selectOption("note.priority");
  await page.keyboard.press("Escape");
  await view.getByRole("button", { name: "Properties" }).click();
  await page.locator(".bases-properties-row", { hasText: "note.owner" }).locator('input[type="checkbox"]').click();
  await page.keyboard.press("Escape");
  await view.getByRole("button", { name: "Filter" }).click();
  panel = page.locator(".bases-filter-panel");
  const scope = panel.locator(".bases-filter-scope").nth(1);
  await scope.getByRole("button", { name: "+ Condition" }).click();
  await scope.locator(".bases-filter-prop").fill("note.status");
  await scope.locator(".bases-filter-value").fill("Done");
  await page.keyboard.press("Escape");
  await view.locator(".bases-view-btn").click();
  await page.getByText("Cards", { exact: true }).click();

  await expect.poll(() => page.evaluate(() => window.hostServices!.vaultFiles.read("Views/Second.base"))).toContain("note.priority");
  const secondBytes = await page.evaluate(() => window.hostServices!.vaultFiles.read("Views/Second.base"));
  expect(secondBytes).toContain("note.status");
  expect(secondBytes).not.toContain("note.owner");
  expect(await page.evaluate((path) => window.hostServices!.vaultFiles.read(path!), recoveryPath)).toContain("Base A recovery");
  await page.waitForTimeout(1_200);
  await page.reload();
  await expect(view.locator(".bases-cards-container")).toBeVisible();
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read("Views/Second.base"))).toBe(secondBytes);
  await expect(view.locator(".bases-conflict-state")).toHaveCount(0);
});

test("@phone @tablet mobile plugins enforce admission, resolver, lifecycle, and quarantine", async ({ page }) => {
  await openExternalProofNote(page);
  await page.evaluate(async () => {
    const host = window.hostServices!.vaultFiles;
    const install = async (id: string, isDesktopOnly: boolean | undefined, code: string, css = "") => {
      await host.mkdir(`.geode/plugins/${id}`);
      const manifest: Record<string, unknown> = { id, name: id, version: "1.0.0", minAppVersion: "1.0.0", description: "mobile fixture", author: "Geode" };
      if (isDesktopOnly !== undefined) manifest.isDesktopOnly = isDesktopOnly;
      await host.write(`.geode/plugins/${id}/manifest.json`, JSON.stringify(manifest));
      await host.write(`.geode/plugins/${id}/main.js`, code);
      if (css) await host.write(`.geode/plugins/${id}/styles.css`, css);
    };
    await install("mobile-dom", false, `
      const { Plugin, FileSystemAdapter } = require("obsidian");
      module.exports = class extends Plugin {
        onload() {
          this.addCommand({ id: "probe", name: "Probe", callback: async () => {
            const adapter = this.app.vault.adapter;
            await this.app.vault.create("Notes/Mobile Plugin.md", JSON.stringify({ dataAdapter: adapter.constructor.name, fileSystem: adapter instanceof FileSystemAdapter, basePath: "basePath" in adapter }));
          }});
          this.registerDomEvent(document, "geode-mobile-probe", () => {});
        }
      };
    `, ".mobile-plugin-style { color: rgb(1, 2, 3); }");
    await install("mobile-cm", false, `const { Plugin } = require("obsidian"); const { StateEffect } = require("@codemirror/state"); module.exports = class extends Plugin { onload() { this.addCommand({ id: "cm", name: StateEffect ? "CM ready" : "CM missing", callback() {} }); } };`);
    await install("desktop-tripwire", true, `globalThis.__desktopTripwire = true; throw new Error("tripwire evaluated");`);
    await install("unknown-mobile", undefined, `const { Plugin } = require("obsidian"); module.exports = class extends Plugin { onload() { this.addCommand({ id: "unknown", name: "Unknown ready", callback() {} }); } };`);
    await install("node-import", false, `const fs = require("node:fs"); module.exports = class {};`);
    await install("startup-throw", false, `const { Plugin } = require("obsidian"); module.exports = class extends Plugin { onload() { this.addCommand({ id: "leak", name: "Must unload", callback() {} }); throw new Error("fixture startup failure"); } };`);
    await (window as any).app.pluginManager.rescan();
  });

  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "More" }).click();
  await page.locator(".menu.mod-mobile-more").getByText("Settings", { exact: true }).click();
  await page.getByText("Community plugins & themes", { exact: true }).click();
  const list = page.locator(".community-list");
  await expect(list.locator('[data-plugin-id="mobile-dom"]')).toContainText("Mobile compatible");
  await expect(list.locator('[data-plugin-id="desktop-tripwire"]')).toContainText("Desktop only");
  await expect(list.locator('[data-plugin-id="unknown-mobile"]')).toContainText("Unknown");
  await expect(list.locator('[data-plugin-id="desktop-tripwire"]')).not.toContainText("Enable");
  expect(await page.evaluate(() => (window as any).__geodeMobileTest.pluginReads.filter((path: string) => path.endsWith("desktop-tripwire/main.js")))).toEqual([]);
  expect(await page.evaluate(() => (window as any).__desktopTripwire)).toBeUndefined();

  await list.locator('[data-plugin-id="mobile-dom"]').getByRole("button", { name: "Enable" }).click();
  await list.locator('[data-plugin-id="mobile-cm"]').getByRole("button", { name: "Enable" }).click();
  expect(await page.evaluate(() => Object.keys((window as any).app.commands.commands).filter((id) => id === "mobile-dom:probe").length)).toBe(1);
  expect(await page.evaluate(() => (window as any).app.commands.execute("mobile-dom:probe"))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.hostServices!.vaultFiles.read("Notes/Mobile Plugin.md"))).toBe('{"dataAdapter":"DataAdapter","fileSystem":false,"basePath":false}');
  await expect(page.locator('style[data-plugin-id="mobile-dom"]')).toHaveCount(1);

  await list.locator('[data-plugin-id="unknown-mobile"]').getByRole("button", { name: "Allow on mobile" }).click();
  await list.locator('[data-plugin-id="unknown-mobile"]').getByRole("button", { name: "Enable" }).click();
  expect(await page.evaluate(() => (window as any).app.commands.has("unknown-mobile:unknown"))).toBe(true);

  await list.locator('[data-plugin-id="node-import"]').getByRole("button", { name: "Enable" }).click();
  await expect(list.locator('[data-plugin-id="node-import"]')).toContainText('unsupported module "node:fs"');
  await expect(list.locator('[data-plugin-id="node-import"]')).not.toContainText("/private/");

  await list.locator('[data-plugin-id="startup-throw"]').getByRole("button", { name: "Enable" }).click();
  await expect(list.locator('.plugin-quarantine-item[data-plugin-id="startup-throw"]')).toContainText("fixture startup failure");
  expect(await page.evaluate(() => (window as any).app.commands.has("startup-throw:leak"))).toBe(false);
  await list.locator('.plugin-quarantine-item[data-plugin-id="startup-throw"]').getByRole("button", { name: "Restore plugin" }).click();
  await expect(list.locator('.plugin-quarantine-item[data-plugin-id="startup-throw"]')).toContainText("fixture startup failure");
  expect(await page.evaluate(() => (window as any).app.commands.has("startup-throw:leak"))).toBe(false);
  await list.locator('.plugin-quarantine-item[data-plugin-id="startup-throw"]').getByRole("button", { name: "Disable plugin" }).click();

  await list.locator('[data-plugin-id="mobile-dom"]').getByRole("button", { name: "Disable" }).click();
  expect(await page.evaluate(() => (window as any).app.commands.has("mobile-dom:probe"))).toBe(false);
  await expect(page.locator('style[data-plugin-id="mobile-dom"]')).toHaveCount(0);
  await list.locator('[data-plugin-id="mobile-dom"]').getByRole("button", { name: "Enable" }).click();
  expect(await page.evaluate(() => Object.keys((window as any).app.commands.commands).filter((id) => id === "mobile-dom:probe").length)).toBe(1);
  await page.evaluate(() => (window as any).__geodeMobileTest.background());
  await page.evaluate(() => (window as any).__geodeMobileTest.foreground());
  expect(await page.evaluate(() => Object.keys((window as any).app.commands.commands).filter((id) => id === "mobile-dom:probe").length)).toBe(1);

  await page.evaluate(async () => {
    await window.hostServices!.vaultFiles.write(".geode/plugins/mobile-dom/main.js", `const { Plugin } = require("obsidian"); module.exports = class extends Plugin { onload() { this.addCommand({ id: "probe-v2", name: "Probe v2", callback() {} }); } };`);
    await (window as any).app.pluginManager.reload("mobile-dom");
  });
  expect(await page.evaluate(() => (window as any).app.commands.has("mobile-dom:probe"))).toBe(false);
  expect(await page.evaluate(() => (window as any).app.commands.has("mobile-dom:probe-v2"))).toBe(true);
  await page.evaluate(async () => {
    await window.hostServices!.vaultFiles.write(".geode/plugins/mobile-dom/main.js", `require("child_process"); module.exports = class {};`);
    await (window as any).app.pluginManager.reload("mobile-dom").catch(() => {});
  });
  expect(await page.evaluate(() => (window as any).app.commands.has("mobile-dom:probe-v2"))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.hostServices!.vaultFiles.read(".geode/plugins/mobile-dom/main.js"))).toContain("probe-v2");

  await page.keyboard.press("Escape");
  await page.reload();
  expect(await page.evaluate(() => Object.keys((window as any).app.commands.commands).filter((id) => id === "mobile-dom:probe-v2").length)).toBe(1);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.evaluate(async () => { await (window as any).app.switchVaultInWindow("external://browser-provider-second"); }),
  ]);
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root)).toBe("external://browser-provider-second");
  expect(await page.evaluate(() => (window as any).app.commands.has("mobile-dom:probe-v2"))).toBe(false);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.evaluate(async () => { await (window as any).app.switchVaultInWindow("external://browser-provider-proof"); }),
  ]);
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root)).toBe("external://browser-provider-proof");
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).app.commands.commands).filter((id) => id === "mobile-dom:probe-v2").length)).toBe(1);
});
