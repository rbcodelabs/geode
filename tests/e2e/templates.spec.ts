import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

async function fixture(files: Record<string, string>) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-templates-vault-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-templates-user-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(vault, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  let app: ElectronApplication | undefined;
  return {
    vault,
    async launch() {
      await app?.close();
      app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot });
      const window = await app.firstWindow();
      await window.waitForFunction(() => !!(window as any).app?.workspace?.layoutReady);
      return window;
    },
    async close() {
      await app?.close();
      fs.rmSync(vault, { recursive: true, force: true });
      fs.rmSync(userData, { recursive: true, force: true });
    },
  };
}

test("daily notes apply the configured template in a clean vault and preserve an existing note", async () => {
  const f = await fixture({
    "Templates/Daily.md": "# {{title}}\n\n## Priorities\n- [ ] Plan today\n\nDate: {{date:YYYY-MM-DD}}\nTime: {{time:HH:mm}}\n",
    ".geode/daily-notes.json": JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD", template: "Templates/Daily" }),
  });
  try {
    const window = await f.launch();
    await window.evaluate(() => (window as any).app.openDailyNote());
    const relative = await window.evaluate(() => (window as any).app.getActiveMarkdownView().file.path);
    const content = fs.readFileSync(path.join(f.vault, relative), "utf8");
    expect(relative).toMatch(/^Journal\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(content).toContain("## Priorities\n- [ ] Plan today");
    expect(content).toContain(`# ${path.basename(relative, ".md")}\n`);
    expect(content).not.toContain("{{");
    expect(content).toMatch(/Time: \d{2}:\d{2}/);
    await window.evaluate(async () => {
      const a = (window as any).app;
      await a.vault.modify(a.getActiveMarkdownView().file, "Keep my daily notes\n");
      await a.openDailyNote();
    });
    expect(fs.readFileSync(path.join(f.vault, relative), "utf8")).toBe("Keep my daily notes\n");
  } finally { await f.close(); }
});

test("a missing daily template reports the problem without creating today's note", async () => {
  const f = await fixture({
    ".geode/daily-notes.json": JSON.stringify({ folder: "Journal", template: "Templates/Missing" }),
  });
  try {
    const window = await f.launch();
    await window.evaluate(() => (window as any).app.commands.execute("daily-note"));
    await expect(window.locator(".notice")).toContainText(/template/i);
    expect(fs.existsSync(path.join(f.vault, "Journal"))).toBe(false);
  } finally { await f.close(); }
});

test("create a Meeting Notes note from the command palette without changing the template or an existing note", async () => {
  const template = "# {{title}}\n\nDate: {{date}}\n\n## Attendees\n\n## Action items\n- [ ] \n";
  const f = await fixture({
    "Templates/Meeting Notes.md": template,
    "Planning.md": "Existing meeting\n",
  });
  try {
    const window = await f.launch();
    await window.keyboard.press("Meta+p");
    await window.locator(".modal .prompt-input").fill("Templates: Create new note from template");
    await expect(window.locator(".modal .prompt-result")).toHaveCount(1);
    await window.locator(".modal .prompt-input").press("Enter");
    await expect(window.getByPlaceholder("Choose a template…")).toBeVisible();
    await window.locator(".modal .prompt-result").filter({ hasText: "Templates/Meeting Notes.md" }).click();
    await window.getByPlaceholder("New note name").fill("Planning");
    await window.getByPlaceholder("New note name").press("Enter");
    await expect.poll(() => window.evaluate(() => (window as any).app.getActiveMarkdownView()?.file?.basename)).toBe("Planning 1");
    const relative = await window.evaluate(() => (window as any).app.getActiveMarkdownView().file.path);
    const content = fs.readFileSync(path.join(f.vault, relative), "utf8");
    expect(content).toContain("# Planning 1\n");
    expect(content).toContain("## Action items\n- [ ]");
    expect(content).not.toContain("{{");
    expect(fs.readFileSync(path.join(f.vault, "Templates/Meeting Notes.md"), "utf8")).toBe(template);
    expect(fs.readFileSync(path.join(f.vault, "Planning.md"), "utf8")).toBe("Existing meeting\n");
    await window.screenshot({ path: path.join(repoRoot, "test-results", "meeting-note-template.png") });
  } finally { await f.close(); }
});

test("insert a template at the saved selection and insert date/time using configured formats", async () => {
  const f = await fixture({
    "Templates/Meeting Notes.md": "{{title}} / {{date}} / {{time}}",
    "Draft.md": "Before REPLACE after",
    ".geode/templates.json": JSON.stringify({ enabled: true, folder: "Templates", dateFormat: "[DATE]", timeFormat: "[TIME]" }),
  });
  try {
    const window = await f.launch();
    await window.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getAbstractFileByPath("Draft.md"), false);
      a.getActiveMarkdownView().editor.dispatch({ selection: { anchor: 7, head: 14 } });
    });
    expect(await window.evaluate(() => (window as any).app.commands.execute("templates:insert-template"))).toBe(true);
    await window.locator(".modal .prompt-result").filter({ hasText: "Meeting Notes" }).click();
    await expect.poll(() => window.evaluate(() => (window as any).app.getActiveMarkdownView().editor.state.doc.toString())).toBe("Before Draft / DATE / TIME after");
    await expect.poll(() => fs.readFileSync(path.join(f.vault, "Draft.md"), "utf8")).toBe("Before Draft / DATE / TIME after");
    await window.evaluate(() => {
      const a = (window as any).app;
      a.commands.execute("templates:insert-date");
      a.commands.execute("templates:insert-time");
    });
    await expect.poll(() => window.evaluate(() => (window as any).app.getActiveMarkdownView().editor.state.doc.toString())).toContain("DATETIME");
  } finally { await f.close(); }
});

test("Templates settings persist across restart and disabling commands preserves configuration", async () => {
  const f = await fixture({ "Snippets/Meeting.md": "Meeting" });
  try {
    let window = await f.launch();
    await window.evaluate(() => (window as any).app.setting.openTabById("templates"));
    let modal = window.locator('.modal.mod-settings[aria-label="Settings"]');
    await expect(modal.getByRole("heading", { name: "Templates", exact: true })).toBeVisible();
    for (const [label, value] of [["Template folder location", "Snippets"], ["Date format", "DD/MM/YYYY"], ["Time format", "h:mm A"]]) {
      await modal.getByRole("textbox", { name: label, exact: true }).fill(value);
      await modal.getByRole("textbox", { name: label, exact: true }).press("Tab");
    }
    await modal.getByRole("checkbox", { name: "Enable Templates" }).uncheck();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(f.vault, ".geode/templates.json"), "utf8"))).toEqual({ enabled: false, folder: "Snippets", dateFormat: "DD/MM/YYYY", timeFormat: "h:mm A" });
    window = await f.launch();
    expect(await window.evaluate(() => (window as any).app.commands.execute("templates:create-note"))).toBe(false);
    await window.evaluate(() => (window as any).app.setting.openTabById("templates"));
    modal = window.locator('.modal.mod-settings[aria-label="Settings"]');
    await expect(modal.getByRole("checkbox", { name: "Enable Templates" })).not.toBeChecked();
    await expect(modal.getByRole("textbox", { name: "Template folder location" })).toHaveValue("Snippets");
    await modal.getByRole("checkbox", { name: "Enable Templates" }).check();
    await expect.poll(() => window.evaluate(() => (window as any).app.templates.enabled)).toBe(true);
    await window.keyboard.press("Escape");
    await window.evaluate(() => (window as any).app.commands.execute("templates:create-note"));
    await expect(window.locator(".modal .prompt-result")).toContainText("Snippets/Meeting.md");
    await window.keyboard.press("Escape");
    expect(fs.readdirSync(f.vault).filter(name => name.endsWith(".md"))).toEqual([]);
  } finally { await f.close(); }
});

test("daily templates work independently of Templates commands and accept an explicit .md path", async () => {
  const f = await fixture({
    "Templates/Daily.md": "# {{title}}\n{{date}} {{time}}\n",
    ".geode/daily-notes.json": JSON.stringify({ folder: "Journal", format: "YYYY/MM/DD", template: "Templates/Daily.md" }),
    ".geode/templates.json": JSON.stringify({ enabled: false, dateFormat: "[DATE]", timeFormat: "[TIME]" }),
  });
  try {
    const window = await f.launch();
    expect(await window.evaluate(() => (window as any).app.commands.execute("templates:create-note"))).toBe(false);
    await window.evaluate(() => (window as any).app.openDailyNote());
    const relative = await window.evaluate(() => (window as any).app.getActiveMarkdownView().file.path);
    expect(relative).toMatch(/^Journal\/\d{4}\/\d{2}\/\d{2}\.md$/);
    expect(fs.readFileSync(path.join(f.vault, relative), "utf8")).toBe(`# ${path.basename(relative, ".md")}\nDATE TIME\n`);
  } finally { await f.close(); }
});

test("template insertion refuses a destination changed while the picker was open", async () => {
  const f = await fixture({ "Templates/Meeting.md": "Meeting body", "Draft.md": "Original" });
  try {
    const window = await f.launch();
    await window.evaluate(async () => {
      const a = (window as any).app;
      await a.openFile(a.vault.getAbstractFileByPath("Draft.md"), false);
      a.commands.execute("templates:insert-template");
      const editor = a.getActiveMarkdownView().editor;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "Updated while choosing" } });
    });
    await window.locator(".modal .prompt-result").filter({ hasText: "Meeting.md" }).click();
    await expect(window.locator(".notice")).toContainText("target note changed");
    expect(await window.evaluate(() => (window as any).app.getActiveMarkdownView().editor.state.doc.toString())).toBe("Updated while choosing");
  } finally { await f.close(); }
});

test("cancelling new-note naming creates nothing and an empty template folder explains setup", async () => {
  const f = await fixture({ "Templates/Meeting.md": "Meeting body" });
  try {
    const window = await f.launch();
    await window.evaluate(() => (window as any).app.commands.execute("templates:create-note"));
    await window.locator(".modal .prompt-result").filter({ hasText: "Meeting.md" }).click();
    await expect(window.getByPlaceholder("New note name")).toBeVisible();
    await window.keyboard.press("Escape");
    expect(fs.readdirSync(f.vault).filter(name => name.endsWith(".md"))).toEqual([]);
    await window.evaluate(async () => {
      const a = (window as any).app;
      await a.templates.update({ folder: "Missing" });
      a.commands.execute("templates:create-note");
    });
    await expect(window.locator(".notice")).toContainText("No templates found");
    await expect(window.locator(".modal")).toHaveCount(0);
  } finally { await f.close(); }
});
