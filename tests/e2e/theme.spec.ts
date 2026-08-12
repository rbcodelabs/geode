import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultPath = path.join(repoRoot, "test-vault");

/**
 * Guards the Obsidian-compatible CSS-variable design system: the documented
 * theme variables must be defined and non-empty (plugins and, later,
 * community themes depend on this contract), and switching the color scheme
 * must actually re-resolve the palette.
 */
test("exposes the Obsidian CSS-variable theme contract and switches schemes", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-theme-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [testVaultPath], lastVault: testVaultPath })
  );
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();

    const requiredVars = [
      "--background-primary",
      "--background-secondary",
      "--background-modifier-border",
      "--text-normal",
      "--text-muted",
      "--text-faint",
      "--text-accent",
      "--interactive-accent",
      "--font-text",
      "--font-monospace",
      "--font-text-size",
      "--h1-size",
      "--size-4-4",
      "--radius-m",
      "--code-background",
      "--link-color",
    ];

    const readVars = () =>
      window.evaluate((names) => {
        const cs = getComputedStyle(document.body);
        const out: Record<string, string> = {};
        for (const n of names) out[n] = cs.getPropertyValue(n).trim();
        return out;
      }, requiredVars);

    // Dark theme: every documented variable is defined and non-empty.
    const dark = await readVars();
    for (const n of requiredVars) expect(dark[n], `${n} in dark`).not.toBe("");
    // --interactive-accent derives from the accent HSL -> a real color.
    expect(dark["--interactive-accent"]).toMatch(/hsl|rgb|#/);
    expect(dark["--font-text-size"]).toBe("16px");

    // Switching to light re-resolves the palette (background flips).
    await window.evaluate(() => {
      const a = (window as any).app;
      a.settings.theme = "light";
      a.applySettings();
    });
    await expect(window.locator("body.theme-light")).toHaveCount(1);
    const light = await readVars();
    for (const n of requiredVars) expect(light[n], `${n} in light`).not.toBe("");
    expect(light["--background-primary"]).not.toBe(dark["--background-primary"]);
    expect(light["--text-normal"]).not.toBe(dark["--text-normal"]);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
