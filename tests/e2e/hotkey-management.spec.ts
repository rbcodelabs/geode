import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const mod = process.platform === "darwin" ? "Meta" : "Control";
const screenshotDir = process.env.GEODE_QA_SCREENSHOT_DIR;

test("Settings manages, persists, and explicitly reassigns live command hotkeys", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hotkeys-vault-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hotkeys-ud-"));
  fs.writeFileSync(path.join(vault, "Note.md"), "# Note\n");
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".workspace")).toBeVisible();
    await page.evaluate(() => (window as any).app.commands.execute("open-settings"));
    await page.getByRole("tab", { name: "Hotkeys" }).click();
    const search = page.getByRole("searchbox", { name: "Search hotkeys" });
    const assignedOnly = page.getByRole("checkbox", { name: "Assigned only" });
    await expect(page.getByRole("tab", { name: "Hotkeys" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Hotkeys", level: 2 })).toBeVisible();
    await expect(page.getByText(/physical hardware keyboard/)).toBeVisible();
    await search.focus();
    await page.keyboard.press("Tab");
    await expect(assignedOnly).toBeFocused();
    await search.focus();
    if (screenshotDir) {
      fs.mkdirSync(screenshotDir, { recursive: true });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 840));
      await page.screenshot({ path: path.join(screenshotDir, "hotkeys-default-large.png") });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 700));
      await page.screenshot({ path: path.join(screenshotDir, "hotkeys-default-small.png") });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 840));
    }
    await page.evaluate(() => {
      const geode = (window as any).app;
      geode.__hotkeyProbe = 0;
      geode.commands.add({ id: "probe:one", name: "Probe one", hotkey: "Mod+J", callback: () => geode.__hotkeyProbe++ });
      geode.commands.add({ id: "probe:two", name: "Probe two", callback: () => geode.__hotkeyProbe += 10 });
      geode.commands.add({ id: "probe:inject", name: '<img src=x onerror="window.__hotkeyInjected=1">', callback: () => {} });
      geode.commands.add({ id: "conflict:default-a", name: "Default conflict A", hotkey: "Mod+U", callback: () => {} });
      geode.commands.add({ id: "conflict:default-b", name: "Default conflict B", hotkey: "Mod+U", callback: () => {} });
    });
    await search.fill("Default conflict");
    const defaultConflictA = page.locator('.hotkey-command[data-command-id="conflict:default-a"]');
    const defaultConflictB = page.locator('.hotkey-command[data-command-id="conflict:default-b"]');
    for (const row of [defaultConflictA, defaultConflictB]) {
      await expect(row.getByText("Conflict", { exact: true })).toBeVisible();
      await expect(row.locator(".hotkey-conflict-indicator")).toHaveAttribute("aria-label", /conflicts with Default conflict/);
    }
    await search.fill("Probe");
    await expect(page.locator(".hotkey-command")).toHaveCount(3);
    expect(await page.locator(".hotkey-command img").count()).toBe(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press(`${mod}+P`);
    await page.locator(".prompt-input").fill("img src");
    expect(await page.locator(".prompt-result img").count()).toBe(0);
    await expect(page.locator(".prompt-result-title")).toContainText("<img src=x");
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window as any).app.commands.execute("open-settings"));
    await page.getByRole("tab", { name: "Hotkeys" }).click();
    await page.getByRole("searchbox", { name: "Search hotkeys" }).fill("Probe");
    const one = page.locator('.hotkey-command[data-command-id="probe:one"]');
    const two = page.locator('.hotkey-command[data-command-id="probe:two"]');
    await expect(page.getByRole("group", { name: "Probe one" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Probe two" })).toBeVisible();
    // Opening a second recorder cancels the first; Escape cancels the active recorder.
    await one.getByRole("button", { name: "Add hotkey for Probe one" }).click();
    await expect(one.getByRole("status")).toContainText("Press Escape to cancel");
    await expect(one.getByRole("button", { name: /Recording hotkey for Probe one/ })).toBeFocused();
    await two.getByRole("button", { name: "Add hotkey for Probe two" }).click();
    await expect(one.getByRole("status")).toHaveCount(0);
    await expect(two.getByRole("status")).toContainText("Press Escape to cancel");
    await page.keyboard.press("Escape");
    await expect(two.getByRole("status")).toContainText("Hotkey recording canceled");
    await expect(two.getByRole("button", { name: "Add hotkey for Probe two" })).toBeFocused();
    expect(await page.evaluate(() => (window as any).app.commands.bindingsFor("probe:two"))).toEqual([]);
    await one.getByRole("button", { name: "Add hotkey for Probe one" }).click();
    await page.getByRole("tab", { name: "Appearance" }).click();
    await page.keyboard.press(`${mod}+K`);
    expect(await page.evaluate(() => (window as any).app.commands.bindingsFor("probe:one").map((b: any) => b.code))).toEqual(["KeyJ"]);
    await page.getByRole("tab", { name: "Hotkeys" }).click();
    await search.fill("Probe");
    await page.getByText("Assigned only").locator("input").check();
    await expect(page.locator(".hotkey-command")).toHaveCount(1);
    await page.getByText("Assigned only").locator("input").uncheck();
    await two.getByRole("button", { name: "Add hotkey for Probe two" }).click();
    await page.keyboard.press(`${mod}+J`);
    const conflict = two.getByRole("alert");
    await expect(conflict).toContainText("Probe one");
    await expect(two.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(two.getByRole("button", { name: "Reassign to Probe two" })).toBeVisible();
    const [rowBox, infoBox, conflictBox] = await Promise.all([
      two.boundingBox(),
      two.locator(".hotkey-command-info").boundingBox(),
      conflict.boundingBox(),
    ]);
    expect(conflictBox!.y).toBeGreaterThanOrEqual(infoBox!.y + infoBox!.height);
    expect(conflictBox!.width).toBeGreaterThanOrEqual(rowBox!.width - 1);
    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, "hotkeys-explicit-conflict.png") });
    }
    await two.getByRole("button", { name: "Cancel" }).click();
    expect(await page.evaluate(() => (window as any).app.commands.bindingsFor("probe:two"))).toEqual([]);
    await two.getByRole("button", { name: "Add hotkey for Probe two" }).click();
    await page.keyboard.press(`${mod}+J`);
    await two.getByRole("button", { name: "Reassign to Probe two" }).click();
    await expect(two.locator(".hotkey-pill")).toContainText(process.platform === "darwin" ? "⌘J" : "Ctrl+J");
    await page.keyboard.press("Escape");
    await page.keyboard.press(`${mod}+J`);
    expect(await page.evaluate(() => (window as any).app.__hotkeyProbe)).toBe(10);
    await page.evaluate(() => (window as any).app.commands.execute("open-settings"));
    await page.getByRole("tab", { name: "Hotkeys" }).click();
    await page.getByRole("searchbox", { name: "Search hotkeys" }).fill("probe:inject");
    const inject = page.locator('.hotkey-command[data-command-id="probe:inject"]');
    await inject.getByRole("button", { name: /Add hotkey/ }).click(); await page.keyboard.press(`${mod}+K`);
    await inject.getByRole("button", { name: /Add hotkey/ }).click(); await page.keyboard.press(`${mod}+L`);
    await expect(inject.locator(".hotkey-pill")).toHaveCount(2);
    await inject.getByRole("button", { name: /Remove.*K.*from.*img src/ }).click();
    await expect(inject.locator(".hotkey-pill")).toHaveCount(1);
    await inject.getByRole("button", { name: /Reset hotkeys for.*img src/ }).click();
    await expect(inject.locator(".hotkey-pill")).toHaveCount(0);
    const saved = JSON.parse(fs.readFileSync(path.join(vault, ".geode", "hotkeys.json"), "utf8"));
    expect(saved.overrides["probe:one"]).toEqual([]);
    expect(saved.overrides["probe:two"][0].code).toBe("KeyJ");
  } finally {
    await app.close();
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test("hotkey overrides survive relaunch and remain isolated to one vault", async () => {
  const vaultA = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hotkeys-a-"));
  const vaultB = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hotkeys-b-"));
  const launch = async (vault: string) => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hotkeys-relaunch-"));
    fs.writeFileSync(path.join(vault, "Note.md"), "# Note\n");
    fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
    const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
    const page = await app.firstWindow(); await expect(page.locator(".workspace")).toBeVisible();
    return { app, page, userData };
  };
  const first = await launch(vaultA);
  await first.page.evaluate(async () => { const c = (window as any).app.commands; c.add({ id: "probe:persist", name: "Persist", hotkey: "Mod+P" }); await c.setBindings("probe:persist", [{ modifiers: ["Mod"], code: "KeyY" }]); });
  await first.app.close(); fs.rmSync(first.userData, { recursive: true, force: true });
  const relaunched = await launch(vaultA);
  expect(await relaunched.page.evaluate(() => { const c = (window as any).app.commands; c.add({ id: "probe:persist", name: "Persist", hotkey: "Mod+P" }); return c.hotkeys().includes("Mod+KeyY"); })).toBe(true);
  await relaunched.app.close(); fs.rmSync(relaunched.userData, { recursive: true, force: true });
  const isolated = await launch(vaultB);
  expect(await isolated.page.evaluate(() => { const c = (window as any).app.commands; c.add({ id: "probe:persist", name: "Persist", hotkey: "Mod+P" }); return c.hotkeys().includes("Mod+KeyY"); })).toBe(false);
  await isolated.app.close(); fs.rmSync(isolated.userData, { recursive: true, force: true });
  fs.rmSync(vaultA, { recursive: true, force: true }); fs.rmSync(vaultB, { recursive: true, force: true });
});
