import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

async function fixture(files: Record<string, string>) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-unique-vault-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "geode-unique-user-"));
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
      app = await electron.launch({
        args: [repoRoot, `--user-data-dir=${userData}`],
        cwd: repoRoot,
        env: { ...process.env, GEODE_HEADLESS: "1" },
      });
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

test("Create new unique note uses the configured folder, format and template", async () => {
  const f = await fixture({
    "Templates/Zettel.md": "# {{title}}\n\nCreated {{date:YYYY-MM-DD}}\n",
    ".geode/unique-notes.json": JSON.stringify({ folder: "Zettel", format: "[Z]YYYYMMDDHHmmss", template: "Templates/Zettel" }),
  });
  try {
    const window = await f.launch();
    await window.evaluate(() => (window as any).app.commands.executeCommandById("unique-note"));
    await window.waitForFunction(() => /^Zettel\/Z\d{14}\.md$/.test((window as any).app.getActiveMarkdownView()?.file?.path ?? ""));
    const relative = await window.evaluate(() => (window as any).app.getActiveMarkdownView().file.path);
    const name = path.basename(relative, ".md");
    const content = fs.readFileSync(path.join(f.vault, relative), "utf8");
    expect(content).toMatch(new RegExp(`^# ${name}\\n\\nCreated \\d{4}-\\d{2}-\\d{2}\\n$`));
    expect(content).not.toContain("{{");
  } finally { await f.close(); }
});

test("default unique note is an empty time-coded note, collisions take the next timestamp, ribbon works", async () => {
  const f = await fixture({});
  try {
    const window = await f.launch();
    const ribbon = window.getByRole("button", { name: "Create new unique note" });
    await expect(ribbon).toBeVisible();
    await ribbon.click();
    await window.waitForFunction(() => /^\d{12}\.md$/.test((window as any).app.getActiveMarkdownView()?.file?.path ?? ""));
    const first = await window.evaluate(() => (window as any).app.getActiveMarkdownView().file.path as string);
    expect(fs.readFileSync(path.join(f.vault, first), "utf8")).toBe("");
    await window.evaluate(() => (window as any).app.commands.executeCommandById("unique-note"));
    await window.waitForFunction((p) => {
      const current = (window as any).app.getActiveMarkdownView()?.file?.path;
      return /^\d{12}\.md$/.test(current ?? "") && current !== p;
    }, first);
    const second = await window.evaluate(() => (window as any).app.getActiveMarkdownView().file.path as string);
    expect(second > first).toBe(true);
    expect(fs.existsSync(path.join(f.vault, first))).toBe(true);
    expect(fs.existsSync(path.join(f.vault, second))).toBe(true);
  } finally { await f.close(); }
});
