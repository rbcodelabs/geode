import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
// Supply a built Agent Threads dist directory. No replacement controller or
// plugin mock: this acceptance test loads the distributable through PluginManager.
const artifactDir = process.env.GEODE_AGENT_THREADS_DIST;
const owner = "claude-threads:conversation-context";

test("real Agent Threads retains one companion across tab closure, plugin reload, and two relaunches", async ({}, testInfo) => {
  test.skip(!artifactDir, "Set GEODE_AGENT_THREADS_DIST to the updated plugin dist directory");
  test.setTimeout(120_000);
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-companion-plugin-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-companion-plugin-ud-"));
  let app: ElectronApplication | undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir!, "manifest.json"), "utf8"));
    expect(manifest.id).toBe("claude-threads");
    const pluginDir = path.join(vaultDir, ".geode", "plugins", manifest.id);
    fs.mkdirSync(pluginDir, { recursive: true });
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      fs.copyFileSync(path.join(artifactDir!, file), path.join(pluginDir, file));
    }
    fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify({
      threadViewPlacement: "conversation-first", hasSeenWelcome: true,
      threads: [], projects: [], scheduledItems: [], skillSources: [], mcpServers: {},
      statusLineCommand: "", autoSummarize: false, telemetryEnabled: false,
      wakeLockEnabled: false, remoteAccess: { enabled: false },
    }));
    fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify([manifest.id]));
    fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
    fs.writeFileSync(path.join(vaultDir, "Context.md"), "# Context\nSynthetic companion integration fixture.\n");
    fs.writeFileSync(path.join(vaultDir, "Sibling.md"), "# Sibling\nPreserve this independent tab.\n");

    const launch = async () => {
      app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
      const win = await app.firstWindow();
      await expect.poll(() => win.evaluate(() => {
        const a = (window as any).app;
        return a?.pluginManager?.isEnabled("claude-threads");
      }), { timeout: 30_000 }).toBe(true);
      return win;
    };
    const openContext = async (win: Page) => {
      await win.evaluate(async () => {
        const a = (window as any).app;
        const plugin = a.pluginManager.getPlugin("claude-threads");
        await new Promise<void>((resolve) => a.workspace.onLayoutReady(resolve));
        await plugin.activateView();
        await plugin.contextPanel.openLinkText("Context.md");
      });
    };
    const assertLayout = async (win: Page) => {
      expect(await win.evaluate((key) => {
        const w = (window as any).app.workspace;
        const groups = w.groups.filter((g: any) => g.companionOwner === key);
        const group = groups[0];
        return {
          groups: w.groups.length, owned: groups.length,
          chat: w.getLeavesOfType("claude-threads:chat").length,
          context: group?.leaves.filter((l: any) => l.view?.getFile?.()?.path === "Context.md").length,
          sibling: group?.leaves.filter((l: any) => l.view?.getFile?.()?.path === "Sibling.md").length,
          designated: group?.leaves.filter((l: any) => l.companionOwner === key).length,
        };
      }, owner)).toEqual({ groups: 2, owned: 1, chat: 1, context: 1, sibling: 1, designated: 1 });
    };
    const waitPersisted = async () => {
      await expect.poll(() => {
        const file = path.join(vaultDir, ".geode", "workspace.json");
        if (!fs.existsSync(file)) return false;
        const layout = JSON.parse(fs.readFileSync(file, "utf8"));
        const nodes: any[] = [];
        const visit = (node: any) => { nodes.push(node); node.children?.forEach(visit); };
        visit(layout.center.root);
        const owned = nodes.filter((n) => n.type === "tabs" && n.companionOwner === owner);
        return owned.length === 1 && owned[0].leaves.some((l: any) => l.file === "Sibling.md")
          && owned[0].leaves.some((l: any) => l.file === "Context.md" && l.companionOwner === owner);
      }, { timeout: 10_000 }).toBe(true);
    };

    let win = await launch();
    await openContext(win);
    await win.evaluate(async (key) => {
      const a = (window as any).app;
      const group = a.workspace.groups.find((g: any) => g.companionOwner === key);
      const destination = group.leaves.find((l: any) => l.companionOwner === key);
      const sibling = group.createLeaf();
      await sibling.openFile(a.vault.getFileByPath("Sibling.md"));
      await destination.detach();
    }, owner);
    await openContext(win);
    await assertLayout(win);
    await win.evaluate(() => (window as any).app.pluginManager.reload("claude-threads"));
    await openContext(win);
    await assertLayout(win);
    for (let cycle = 0; cycle < 2; cycle++) {
      await waitPersisted();
      await app!.close();
      app = undefined;
      win = await launch();
      await openContext(win);
      await assertLayout(win);
    }
    await waitPersisted();
    await win.screenshot({ path: testInfo.outputPath("companion-plugin-lifecycle.png") });
    await testInfo.attach("companion-plugin-lifecycle", { path: testInfo.outputPath("companion-plugin-lifecycle.png"), contentType: "image/png" });
    expect(fs.readFileSync(path.join(vaultDir, "Sibling.md"), "utf8")).toContain("Preserve this independent tab.");
  } finally {
    await app?.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
