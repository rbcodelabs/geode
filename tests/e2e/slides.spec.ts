import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
// Set SLIDES_SHOTS_DIR to also capture screenshots of each state (manual QA).
const shotsDir = process.env.SLIDES_SHOTS_DIR;

const DECK = [
  "---",
  "title: Deck",
  "---",
  "# Welcome",
  "",
  "A [[Other]] wikilink and **bold** text.",
  "",
  "---",
  "",
  "## Code",
  "",
  "```js",
  "const a = 1;",
  "",
  "---",
  "",
  "const b = 2;",
  "```",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "---",
  "",
  "> [!note] A callout",
  "> inside the callout",
  "",
  "---",
  "",
  "Last slide, with an embed:",
  "",
  "![[Other]]",
  "",
].join("\n");

test("Slides: start from command and tab menu, navigate, close", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-slides-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-slides-e2e-"));
  fs.writeFileSync(path.join(vaultDir, "Deck.md"), DECK);
  fs.writeFileSync(path.join(vaultDir, "Other.md"), "Embedded body text\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_HEADLESS: "1" },
  });
  try {
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1280, height: 800 });
    await win.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);

    const hasCommand = () =>
      win.evaluate(() =>
        Object.keys((window as any).app.commands?.commands ?? {}).some((id) => id === "slides:start")
      );

    // Off by default: no command.
    expect(await hasCommand()).toBe(false);

    await win.evaluate(() => (window as any).app.setting.openTabById("core-plugins"));
    await win.getByLabel("Enable Slides").check();
    await win.keyboard.press("Escape");
    expect(await hasCommand()).toBe(true);

    await win.evaluate(() => (window as any).app.openFile((window as any).app.vault.getFileByPath("Deck.md"), false));
    await expect(win.locator(".workspace-tab-header.is-active[data-type='markdown']")).toContainText("Deck");

    const overlay = win.locator(".slides-presentation");
    const prev = overlay.locator(".slides-prev");
    const next = overlay.locator(".slides-next");
    const shot = async (name: string) => {
      if (shotsDir) await win.screenshot({ path: path.join(shotsDir, `${name}.png`) });
    };

    // --- Start from the command ---
    await expect(overlay).toHaveCount(0);
    await win.evaluate(() => (window as any).app.commands.execute("slides:start"));
    await expect(overlay).toHaveAttribute("data-slide-count", "4");
    await expect(overlay).toHaveAttribute("data-slide-ready", "0");
    await expect(overlay.locator(".slides-content h1")).toHaveText("Welcome");
    // Frontmatter is not slide content; the wikilink is rendered as a link.
    await expect(overlay).not.toContainText("title: Deck");
    await expect(overlay.locator(".slides-content a.internal-link")).toHaveText("Other");
    await expect(prev).toBeDisabled();
    await expect(next).toBeEnabled();
    await shot("light-first");

    // Space advances.
    await win.keyboard.press("Space");
    await expect(overlay).toHaveAttribute("data-slide-ready", "1");
    // The --- inside the fence and the table rule did not split the slide.
    await expect(overlay.locator(".slides-content pre")).toContainText("const b = 2;");
    await expect(overlay.locator(".slides-content table")).toHaveCount(1);
    await expect(prev).toBeEnabled();

    // Right arrow -> callout slide.
    await win.keyboard.press("ArrowRight");
    await expect(overlay).toHaveAttribute("data-slide-ready", "2");
    await expect(overlay.locator(".slides-content .callout")).toContainText("inside the callout");
    await shot("light-callout");

    // Left arrow goes back.
    await win.keyboard.press("ArrowLeft");
    await expect(overlay).toHaveAttribute("data-slide-ready", "1");
    await win.keyboard.press("ArrowRight");
    await expect(overlay).toHaveAttribute("data-slide-ready", "2");

    // Next button -> last slide, which disables next and renders the embed.
    await next.click();
    await expect(overlay).toHaveAttribute("data-slide-ready", "3");
    await expect(overlay.locator(".slides-content")).toContainText("Embedded body text");
    await expect(next).toBeDisabled();
    await expect(prev).toBeEnabled();
    await shot("light-last");

    // Pressing past the end stays on the last slide.
    await win.keyboard.press("ArrowRight");
    await win.keyboard.press("Space");
    await expect(overlay).toHaveAttribute("data-slide-index", "3");

    // Previous button.
    await prev.click();
    await expect(overlay).toHaveAttribute("data-slide-ready", "2");

    // Dark theme.
    await win.evaluate(() => {
      const a = (window as any).app;
      a.settings.theme = "dark";
      a.applySettings();
    });
    await expect(win.locator("body")).toHaveClass(/theme-dark/);
    await shot("dark-callout");
    for (let i = 0; i < 3; i++) await win.keyboard.press("ArrowLeft");
    await expect(overlay).toHaveAttribute("data-slide-ready", "0");
    await expect(prev).toBeDisabled();
    await shot("dark-first");
    for (let i = 0; i < 3; i++) await win.keyboard.press("ArrowRight");
    await expect(overlay).toHaveAttribute("data-slide-ready", "3");
    await shot("dark-last");

    // Esc ends the presentation.
    await win.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    // Keys no longer navigate once closed.
    await expect(win.locator(".workspace-tab-header.is-active[data-type='markdown']")).toContainText("Deck");

    // --- Start from the tab context menu; close button ends it ---
    await win.evaluate(() => {
      const a = (window as any).app;
      a.settings.theme = "light";
      a.applySettings();
    });
    await win.locator(".workspace-tab-header.is-active[data-type='markdown']").click({ button: "right" });
    const item = win.locator(".menu .menu-item", { hasText: "Start presentation" });
    await expect(item).toBeVisible();
    await shot("tab-menu");
    await item.click();
    await expect(overlay).toHaveAttribute("data-slide-ready", "0");
    await expect(overlay.locator(".slides-content h1")).toHaveText("Welcome");
    await overlay.locator(".slides-close").click();
    await expect(overlay).toHaveCount(0);

    // Disabling the plugin removes the command and the menu entry.
    await win.evaluate(() => (window as any).app.setting.openTabById("core-plugins"));
    await win.getByLabel("Enable Slides").uncheck();
    await win.keyboard.press("Escape");
    expect(await hasCommand()).toBe(false);
    await win.locator(".workspace-tab-header.is-active[data-type='markdown']").click({ button: "right" });
    await expect(win.locator(".menu .menu-item", { hasText: "Close" }).first()).toBeVisible();
    await expect(win.locator(".menu .menu-item", { hasText: "Start presentation" })).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
