import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const manifest = {
  id: "frontmatter-probe",
  name: "Frontmatter Probe",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Exercises FileManager.processFrontMatter through the hosted plugin runtime.",
  author: "geode",
};

const mainJs = `
  const { Plugin } = require('obsidian');

  module.exports.default = class FrontmatterProbe extends Plugin {
    async onload() {
      this.mutationStarted = false;
      this.app.notify('frontmatter probe loaded');
      this.registerEvent(this.app.metadataCache.on('changed', (file) => {
        if (this.mutationStarted && file.path === 'Note.md') this.app.notify('frontmatter cache refreshed');
      }));
      this.registerEvent(this.app.vault.on('modify', (file) => {
        if (this.mutationStarted && file.path === 'Note.md') this.app.notify('frontmatter vault modify event');
      }));
      this.addCommand({
        id: 'mutate',
        name: 'Mutate frontmatter',
        callback: async () => {
          const file = this.app.vault.getFileByPath('Note.md');
          this.mutationStarted = true;
          await Promise.all([
            this.app.fileManager.processFrontMatter(file, (fm) => { fm.first = true; }),
            this.app.fileManager.processFrontMatter(file, (fm) => { fm.second = true; }),
          ]);
          this.app.notify('frontmatter mutation persisted');
        },
      });
      this.addCommand({
        id: 'throw',
        name: 'Throw during frontmatter mutation',
        callback: async () => {
          const file = this.app.vault.getFileByPath('Note.md');
          const before = await this.app.vault.read(file);
          try {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
              fm.mustNotPersist = true;
              throw new Error('expected callback failure');
            });
          } catch (error) {
            const after = await this.app.vault.read(file);
            this.app.notify(before === after ? 'thrown callback wrote zero bytes' : 'thrown callback changed file');
          }
        },
      });
    }
  };
`;

async function launch(vaultDir: string, userDataDir: string): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  return { app, window: await app.firstWindow() };
}

test("hosted plugin processFrontMatter persists, refreshes metadata, reloads, and keeps thrown callbacks zero-write", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-frontmatter-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-frontmatter-e2e-"));
  const notePath = path.join(vaultDir, "Note.md");
  fs.writeFileSync(notePath, "---\nexisting: kept\n---\nBody bytes stay here.\n");

  const pluginDir = path.join(vaultDir, ".geode", "plugins", manifest.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(pluginDir, "main.js"), mainJs);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify([manifest.id]));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  let running: ElectronApplication | null = null;
  try {
    const first = await launch(vaultDir, userDataDir);
    running = first.app;

    await expect(first.window.locator(".notice", { hasText: "frontmatter probe loaded" })).toBeVisible();
    expect(await first.window.evaluate(() => (window as any).app.commands.execute("frontmatter-probe:mutate"))).toBe(true);
    await expect(first.window.locator(".notice", { hasText: "frontmatter mutation persisted" })).toBeVisible();
    await expect(first.window.locator(".notice", { hasText: "frontmatter vault modify event" }).first()).toBeVisible();
    await expect(first.window.locator(".notice", { hasText: "frontmatter cache refreshed" }).first()).toBeVisible();
    await expect.poll(() => fs.readFileSync(notePath, "utf8")).toContain("first: true");
    const persisted = fs.readFileSync(notePath, "utf8");
    expect(persisted).toContain("existing: kept");
    expect(persisted).toContain("second: true");
    expect(persisted).toContain("Body bytes stay here.\n");

    await expect.poll(() => first.window.evaluate(() => {
      const app = (window as any).app;
      return app.metadataCache.getFileCache(app.vault.getFileByPath("Note.md"))?.frontmatter;
    })).toMatchObject({ existing: "kept", first: true, second: true });

    const beforeThrow = fs.readFileSync(notePath, "utf8");
    expect(await first.window.evaluate(() => (window as any).app.commands.execute("frontmatter-probe:throw"))).toBe(true);
    await expect(first.window.locator(".notice", { hasText: "thrown callback wrote zero bytes" })).toBeVisible();
    expect(fs.readFileSync(notePath, "utf8")).toBe(beforeThrow);

    await first.app.close();
    running = null;

    const reloaded = await launch(vaultDir, userDataDir);
    running = reloaded.app;
    await expect(reloaded.window.locator(".notice", { hasText: "frontmatter probe loaded" })).toBeVisible();
    await expect.poll(() => reloaded.window.evaluate(() => {
      const app = (window as any).app;
      const file = app.vault.getFileByPath("Note.md");
      return app.metadataCache.getFileCache(file)?.frontmatter;
    })).toMatchObject({ existing: "kept", first: true, second: true });
    expect(fs.readFileSync(notePath, "utf8")).toBe(beforeThrow);
  } finally {
    await running?.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
