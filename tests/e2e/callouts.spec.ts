import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const NOTE = `# Callouts

> [!tip] Handy trick
> Use Cmd+E to toggle reading view.

> [!warning]
> No title given, so this uses the default "Warning" title.
`;

test("renders Obsidian-style callouts with an icon, colored title, and type class in both Live Preview and reading view", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-callout-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-callout-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Callouts.md"), NOTE);
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();

    await window.locator('.nav-file-title[data-path="Callouts.md"]').click();
    await expect(window.locator(".cm-editor")).toBeVisible();

    // --- Live Preview -------------------------------------------------
    const lpTipHeader = window.locator(".cm-callout-title.callout-tip");
    await expect(lpTipHeader).toBeVisible();
    // The `[!tip]` marker is replaced by an inline Lucide icon widget…
    await expect(lpTipHeader.locator(".cm-callout-icon svg")).toBeVisible();
    // …while the title text stays visible and editable.
    await expect(lpTipHeader).toContainText("Handy trick");
    await expect(lpTipHeader).not.toContainText("[!tip]");

    // Tinted background applies to every line of the callout, not just the header.
    await expect(window.locator(".cm-callout.callout-tip")).toHaveCount(2);

    // Second callout: no explicit title given.
    const lpWarningHeader = window.locator(".cm-callout-title.callout-warning");
    await expect(lpWarningHeader).toBeVisible();
    await expect(lpWarningHeader.locator(".cm-callout-icon svg")).toBeVisible();

    // --- Reading view ---------------------------------------------------
    await window.locator(".view-mode-toggle", { hasText: "📖" }).click();
    await expect(window.locator(".markdown-reading-view")).toBeVisible();

    const tipCallout = window.locator(".callout.callout-tip");
    await expect(tipCallout).toBeVisible();
    await expect(tipCallout).toHaveAttribute("data-callout", "tip");
    await expect(tipCallout.locator(".callout-title .callout-icon svg")).toBeVisible();
    await expect(tipCallout.locator(".callout-title-inner")).toHaveText("Handy trick");
    await expect(tipCallout.locator(".callout-content")).toContainText("Use Cmd+E to toggle reading view.");

    const warningCallout = window.locator(".callout.callout-warning");
    await expect(warningCallout).toBeVisible();
    await expect(warningCallout.locator(".callout-title-inner")).toHaveText("Warning"); // defaulted title
    await expect(warningCallout.locator(".callout-title .callout-icon svg")).toBeVisible();

    // Tinted background + colored title actually take effect (not just present as classes).
    const tipBg = await tipCallout.evaluate((el) => getComputedStyle(el).backgroundColor);
    const bodyBg = await window.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(tipBg).not.toBe(bodyBg);
    const tipTitleColor = await tipCallout
      .locator(".callout-title")
      .evaluate((el) => getComputedStyle(el).color);
    const warningTitleColor = await warningCallout
      .locator(".callout-title")
      .evaluate((el) => getComputedStyle(el).color);
    expect(tipTitleColor).not.toBe(warningTitleColor);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
