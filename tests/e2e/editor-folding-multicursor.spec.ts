import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "../..");
const text = "# Parent\nparent body\n## Child\nchild body\n- parent item\n  - nested item\n# Next\nlast body";
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const view = (window as any).app.getActiveMarkdownView();
    return { text: view.editor.state.doc.toString(), ranges: view.editor.state.selection.ranges.length, folds: view.getState().folding.ranges.length };
  });
}
async function command(page: Page, name: string) {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+p" : "Control+p");
  await page.locator(".prompt-input").fill(name);
  await page.locator(".prompt-result").filter({ hasText: name }).first().click();
}
async function point(page: Page, position: number) {
  return page.evaluate(position => {
    const view = (window as any).app.getActiveMarkdownView();
    view.editor.focus();
    const rect = view.editor.coordsAtPos(position);
    return { x: rect.left + 1, y: (rect.top + rect.bottom) / 2 };
  }, position);
}

test("heading and list folding, settings, nested commands and workspace restoration", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-fold-vault-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-fold-ud-"));
  fs.writeFileSync(path.join(vault, "Note.md"), text);
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  let app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
  try {
    let page = await app.firstWindow();
    await page.locator('.nav-file-title[data-path="Note.md"]').click();
    await expect(page.locator(".geode-fold-toggle")).toHaveCount(4);
    await page.locator('.geode-fold-toggle[aria-label="Fold section"]').first().click();
    await expect(page.locator('.geode-fold-toggle[aria-label="Unfold section"]')).toHaveCount(1);
    await expect(page.locator(".cm-content")).not.toContainText("child body");
    await page.locator('.geode-fold-toggle[aria-label="Unfold section"]').click();
    await expect(page.locator(".cm-content")).toContainText("child body");
    await command(page, "Fold all headings and lists");
    expect((await snapshot(page)).folds).toBe(4);
    await command(page, "Unfold all headings and lists");
    expect((await snapshot(page)).folds).toBe(0);
    await page.evaluate(() => (window as any).app.getActiveMarkdownView().editor.dispatch({ selection: { anchor: 34 } }));
    await command(page, "Fold more");
    expect((await snapshot(page)).folds).toBe(1);
    await command(page, "Fold less");
    expect((await snapshot(page)).folds).toBe(0);

    await page.getByRole("button", { name: "Toggle Live Preview / Source mode", exact: true }).click();
    await expect(page.locator(".cm-content")).toContainText("# Parent");
    await page.locator('.geode-fold-toggle[aria-label="Fold section"]').first().click();
    await page.getByRole("button", { name: "Toggle Live Preview / Source mode", exact: true }).click();
    expect((await snapshot(page)).folds).toBe(1);
    await command(page, "Unfold all headings and lists");

    // Settings act on existing editors immediately, and keep the two kinds independent.
    await page.evaluate(() => (window as any).app.setting.openTabById("editor"));
    const toggle = (name: string) => page.locator(".setting-item").filter({ has: page.locator(".setting-item-name", { hasText: name }) }).locator('input[type="checkbox"]');
    await toggle("Fold heading").uncheck();
    await page.keyboard.press("Escape");
    await expect(page.locator(".geode-fold-toggle")).toHaveCount(1);
    await page.evaluate(() => (window as any).app.setting.openTabById("editor"));
    await toggle("Fold heading").check();
    await page.keyboard.press("Escape");
    await expect(page.locator(".geode-fold-toggle")).toHaveCount(4);
    await page.locator('.geode-fold-toggle[aria-label="Fold section"]').first().click();
    await expect.poll(() => fs.existsSync(path.join(vault, ".geode", "workspace.json")) && JSON.parse(fs.readFileSync(path.join(vault, ".geode", "workspace.json"), "utf8")).version).toBe(3);
    // Wait for the debounced workspace write to include the fold.
    await expect.poll(() => fs.readFileSync(path.join(vault, ".geode", "workspace.json"), "utf8")).toMatch(/"ranges"\s*:\s*\[\s*{/);
    await page.screenshot({ path: test.info().outputPath("folding.png") });
    await app.close();
    app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
    page = await app.firstWindow();
    await expect(page.locator('.geode-fold-toggle[aria-label="Unfold section"]')).toHaveCount(1);
    expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe(text);
  } finally { await app.close(); fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); }
});

test("Alt-click multi-edit, undo, Escape, and both rectangular selection gestures", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-multi-vault-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-multi-ud-"));
  fs.writeFileSync(path.join(vault, "Note.md"), "alpha\nbravo\ncharlie");
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
  try {
    const page = await app.firstWindow();
    await page.locator('.nav-file-title[data-path="Note.md"]').click();
    const first = await point(page, 0), second = await point(page, 6);
    await page.mouse.click(first.x, first.y);
    await page.keyboard.down("Alt");
    await page.mouse.click(second.x, second.y);
    await page.keyboard.up("Alt");
    expect((await snapshot(page)).ranges).toBe(2);
    await page.keyboard.type("-");
    expect((await snapshot(page)).text).toBe("-alpha\n-bravo\ncharlie");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    expect((await snapshot(page)).text).toBe("alpha\nbravo\ncharlie");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Backspace");
    expect((await snapshot(page)).text).toBe("lpha\nravo\ncharlie");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await page.keyboard.press("Escape");
    expect((await snapshot(page)).ranges).toBe(1);
    for (const middle of [false, true]) {
      const start = await point(page, 0), end = await point(page, 12);
      if (!middle) { await page.keyboard.down("Alt"); await page.keyboard.down("Shift"); }
      await page.mouse.move(start.x, start.y);
      await page.mouse.down({ button: middle ? "middle" : "left" });
      await page.mouse.move(end.x + 8, end.y, { steps: 6 });
      await page.mouse.up({ button: middle ? "middle" : "left" });
      if (!middle) { await page.keyboard.up("Shift"); await page.keyboard.up("Alt"); }
      expect((await snapshot(page)).ranges).toBe(3);
      if (middle) await page.screenshot({ path: test.info().outputPath("multiple-cursors.png") });
      await page.keyboard.type(">");
      expect((await snapshot(page)).text.split("\n").every(line => line.startsWith(">"))).toBe(true);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
      await page.keyboard.press("Escape");
    }
    await page.keyboard.down("Alt");
    await page.mouse.click(second.x, second.y);
    await page.keyboard.up("Alt");
    expect((await snapshot(page)).ranges).toBeGreaterThan(1);
    await page.mouse.click(first.x, first.y);
    expect((await snapshot(page)).ranges).toBe(1);
  } finally { await app.close(); fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); }
});


test("editing gutters stay transparent and borderless in both themes and modes", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-gutter-vault-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-gutter-ud-"));
  fs.writeFileSync(path.join(vault, "Note.md"), text);
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
  try {
    const page = await app.firstWindow();
    await page.locator('.nav-file-title[data-path="Note.md"]').click();
    for (const theme of ["dark", "light"]) {
      await page.evaluate(theme => (window as any).app.setTheme(theme === "dark" ? "obsidian" : "moonstone"), theme);
      await expect(page.locator("body")).toHaveClass(new RegExp(`theme-${theme}`));
      for (const mode of ["live", "source"]) {
        await page.evaluate(async mode => {
          const view = (window as any).app.getActiveMarkdownView();
          if (view.mode !== mode) await view.toggleSource();
        }, mode);
        await expect.poll(() => page.evaluate(() => (window as any).app.getActiveMarkdownView().mode)).toBe(mode);
        await expect(page.locator(".geode-fold-toggle")).toHaveCount(4);
        const style = await page.locator(".cm-editor .cm-gutters").evaluate(el => {
          const css = getComputedStyle(el);
          return { background: css.backgroundColor, left: css.borderLeftWidth, right: css.borderRightWidth };
        });
        expect.soft(style, `${theme}/${mode} gutter`).toEqual({ background: "rgba(0, 0, 0, 0)", left: "0px", right: "0px" });
        await page.screenshot({ path: test.info().outputPath(`gutter-${theme}-${mode}.png`) });
      }
    }
    expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe(text);
  } finally { await app.close(); fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); }
});
