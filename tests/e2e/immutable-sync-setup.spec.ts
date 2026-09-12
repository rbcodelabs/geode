import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import {
  SYNC_CONFLICT_CANCEL_LABEL,
  SYNC_CONFLICT_DIALOG_SUBTITLE,
  SYNC_CONFLICT_DIALOG_TITLE,
  SYNC_CONFLICT_KEEP_LOCAL_LABEL,
  SYNC_CONFLICT_LOCAL_PANEL_TITLE,
  SYNC_CONFLICT_REMOTE_PANEL_TITLE,
  SYNC_CONFLICT_USE_REMOTE_LABEL,
  formatHeadLabels,
} from "../../src/renderer/sync/conflict-presentation";
const root = path.resolve(__dirname, "../..");
test("immutable setup requires explicit create and preview through real settings", async ({}, info) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-history-ui-")); const profile = fs.mkdtempSync(path.join(os.tmpdir(), "geode-history-profile-"));
  fs.writeFileSync(path.join(vault, "Note.md"), "local"); fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root });
  try {
    const page = await app.firstWindow(); await page.waitForFunction(() => Boolean((window as any).app?.workspace));
    await page.evaluate(() => {
      const app = (window as any).app;
      const descriptor = { schema: 1, protocol: "append-only-history-v1", vaultId: "12345678-1234-4234-8234-123456789012", rootId: "synthetic-root", descriptorId: "synthetic-descriptor", name: "Synthetic shared vault" };
      app.sync.register("synthetic-fixture", { id: "history.fixture", name: "Immutable fixture", protocol: "append-only-history-v1", capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
        discover: async () => [descriptor], createVault: async () => descriptor, open: async () => ({ scan: async () => ({ status: "complete", records: [] }), close: async () => {} }),
      }); app.setting.openTabById("sync");
    });
    const modal = page.locator('.modal.mod-settings[aria-label="Settings"]');
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("history.fixture");
    await modal.getByRole("textbox", { name: "Shared vault name" }).fill("Synthetic shared vault");
    await modal.getByRole("button", { name: "Create shared vault", exact: true }).click();
    await expect(modal).toContainText("Shared vault created");
    await modal.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(modal).toContainText("upload");
    expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe("local");
    await page.setViewportSize({ width: 800, height: 800 });
    const setup = modal.locator('.setting-item').filter({ has: page.getByText('Shared vault setup', { exact: true }) });
    expect((await setup.locator('.setting-item-info').boundingBox())!.width).toBeGreaterThanOrEqual(240);
    expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(setup.getByRole('button', { name: 'Create shared vault', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("immutable-setup-small.png") });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: info.outputPath("immutable-setup-large.png") });
  } finally { await app.close(); fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); }
});

/**
 * Layout guard for the comparison dialog, with the read-only comparison surface
 * stubbed so the shape under test is the dialog's own: five heads (well past
 * the two a flat local/remote view could show), both panels painted, and no
 * horizontal overflow at a narrow window. The end-to-end behaviour against a
 * real multi-client conflict lives in immutable-sync-multiclient.spec.ts; this
 * one exists to pin the rendering deterministically and without a 3-app fixture.
 */
const HEAD_DEVICES = ["a3f2c1d4", "b7e10c22", "c04d9e31", "d5a9f7b8", "e6b02a45"];

test("the conflict comparison dialog renders every head and fits a narrow window", async ({}, info) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-conflict-dialog-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "geode-conflict-dialog-profile-"));
  fs.writeFileSync(path.join(vault, "Note.md"), "local body");
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean((window as any).app?.workspace));
    await page.setViewportSize({ width: 1440, height: 1000 });

    const heads = HEAD_DEVICES.map((device, index) => ({
      recordId: `${index}${index}${index}${index}${index}${index}${index}${index}-aaaa-4aaa-8aaa-${index}${index}${index}${index}${index}${index}${index}${index}${index}${index}${index}${index}`,
      deviceId: `${device}-1111-4111-8111-111111111111`,
      kind: "file" as const, deleted: false, name: "Note.md", parentId: null, size: 12, sha256: `sha-${index}`,
    }));
    await page.evaluate(heads => {
      const app = (window as any).app;
      app.sync.describeHistoryConflict = async () => ({
        entityId: "entity-1", namespace: "content", path: "Note.md", reason: "concurrent-heads",
        heads, local: { path: "Note.md", present: true, size: 10, sha256: "sha-local" }, comparable: true,
      });
      app.sync.readHistoryConflictText = async (_entityId: string, choice: any) =>
        choice.kind === "current" ? "local body" : `body of ${choice.recordId.slice(0, 8)}`;
      app.openConflictComparison({ entityId: "entity-1", path: "Note.md" });
    }, heads);

    const dialog = page.locator(".modal.sync-conflict-modal");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".sync-conflict-title")).toHaveText(SYNC_CONFLICT_DIALOG_TITLE);
    await expect(dialog.locator(".sync-conflict-subtitle")).toHaveText(SYNC_CONFLICT_DIALOG_SUBTITLE);
    await expect(dialog.locator(".sync-conflict-message")).toBeHidden();

    // Both panels actually paint, and neither is an editor.
    const panels = dialog.locator(".sync-conflict-panel");
    await expect(panels.nth(0).locator(".sync-conflict-panel-title")).toHaveText(SYNC_CONFLICT_LOCAL_PANEL_TITLE);
    await expect(panels.nth(1).locator(".sync-conflict-panel-title")).toHaveText(SYNC_CONFLICT_REMOTE_PANEL_TITLE);
    await expect(panels.nth(0).locator(".sync-conflict-panel-text")).toHaveText("local body");
    await expect(panels.nth(1).locator(".sync-conflict-panel-text")).toHaveText(`body of ${heads[0].recordId.slice(0, 8)}`);
    await expect(dialog.locator("textarea, [contenteditable='true']")).toHaveCount(0);

    // Every head is offered, labelled opaquely, in the order sync reported.
    const options = dialog.locator("select.sync-conflict-version-select option");
    await expect(options).toHaveCount(5);
    expect(await options.evaluateAll(nodes => nodes.map(node => node.textContent ?? ""))).toEqual(formatHeadLabels(heads));
    expect(await options.evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value))).toEqual(heads.map(head => head.recordId));

    // Both resolutions are live once the comparison loaded.
    await expect(dialog.getByRole("button", { name: SYNC_CONFLICT_KEEP_LOCAL_LABEL, exact: true })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: SYNC_CONFLICT_USE_REMOTE_LABEL, exact: true })).toBeEnabled();

    // Selecting a different head repaints only the synced side.
    await dialog.locator("select.sync-conflict-version-select").selectOption(heads[3].recordId);
    await expect(panels.nth(1).locator(".sync-conflict-panel-text")).toHaveText(`body of ${heads[3].recordId.slice(0, 8)}`);
    await expect(panels.nth(0).locator(".sync-conflict-panel-text")).toHaveText("local body");

    const shoot = async (slug: string) => {
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(value => (window as any).app.setTheme(value), theme === "dark" ? "obsidian" : "moonstone");
        await expect.poll(() => page.evaluate(value => document.body.classList.contains(value), `theme-${theme}`)).toBe(true);
        for (const [label, size] of [["narrow", { width: 760, height: 820 }], ["wide", { width: 1440, height: 1000 }]] as const) {
          await page.setViewportSize(size);
          await expect(dialog).toBeVisible();
          await page.screenshot({ path: info.outputPath(`${slug}-${theme}-${label}.png`) });
        }
      }
    };
    await shoot("conflict-dialog-loaded");

    // Narrow: nothing clipped horizontally, every control still reachable.
    await page.setViewportSize({ width: 760, height: 820 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    for (const label of [SYNC_CONFLICT_CANCEL_LABEL, SYNC_CONFLICT_KEEP_LOCAL_LABEL, SYNC_CONFLICT_USE_REMOTE_LABEL]) {
      await expect(dialog.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    await expect(dialog.locator("select.sync-conflict-version-select")).toBeVisible();
    expect(await dialog.evaluate(element => element.getBoundingClientRect().right <= window.innerWidth + 1)).toBe(true);

    // Wide: the two panels sit side by side rather than stacking.
    await page.setViewportSize({ width: 1440, height: 1000 });
    const [left, right] = [await panels.nth(0).boundingBox(), await panels.nth(1).boundingBox()];
    expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x + 1);
    expect(Math.abs(left!.y - right!.y)).toBeLessThan(4);
  } finally {
    await app.close();
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
