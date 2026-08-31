import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const mod = process.platform === "darwin" ? "Meta" : "Control";

test("Settings manages, persists, and explicitly reassigns live command hotkeys", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hotkeys-vault-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hotkeys-ud-"));
  fs.writeFileSync(path.join(vault, "Note.md"), "# Note\n");
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".workspace")).toBeVisible();
    await page.evaluate(() => {
      const geode = (window as any).app;
      geode.__hotkeyProbe = 0;
      geode.commands.add({ id: "probe:one", name: "Probe one", hotkey: "Mod+J", callback: () => geode.__hotkeyProbe++ });
      geode.commands.add({ id: "probe:two", name: "Probe two", callback: () => geode.__hotkeyProbe += 10 });
      geode.commands.execute("open-settings");
    });
    await page.getByRole("tab", { name: "Hotkeys" }).click();
    const search = page.getByRole("searchbox", { name: "Search hotkeys" });
    await search.fill("Probe");
    await expect(page.locator(".hotkey-command")).toHaveCount(2);
    const two = page.locator('.hotkey-command[data-command-id="probe:two"]');
    await two.getByRole("button", { name: "Add hotkey for Probe two" }).click();
    await page.keyboard.press(`${mod}+J`);
    await expect(two.locator(".hotkey-conflict-choice")).toContainText("Probe one");
    await two.getByRole("button", { name: "Cancel" }).click();
    expect(await page.evaluate(() => (window as any).app.commands.bindingsFor("probe:two"))).toEqual([]);
    await two.getByRole("button", { name: "Add hotkey for Probe two" }).click();
    await page.keyboard.press(`${mod}+J`);
    await two.getByRole("button", { name: "Reassign to Probe two" }).click();
    await expect(two.locator(".hotkey-pill")).toContainText(process.platform === "darwin" ? "⌘J" : "Ctrl+J");
    await page.keyboard.press("Escape");
    await page.keyboard.press(`${mod}+J`);
    expect(await page.evaluate(() => (window as any).app.__hotkeyProbe)).toBe(10);
    const saved = JSON.parse(fs.readFileSync(path.join(vault, ".geode", "hotkeys.json"), "utf8"));
    expect(saved.overrides["probe:one"]).toEqual([]);
    expect(saved.overrides["probe:two"][0].code).toBe("KeyJ");
  } finally {
    await app.close();
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
