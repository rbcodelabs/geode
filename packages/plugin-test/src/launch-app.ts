import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginSource } from "./index";

const repoRoot = path.resolve(__dirname, "../../..");

export interface LaunchAppOptions {
  plugins: PluginSource[];
  /** Per-plugin data.json contents, keyed by plugin id. */
  pluginData?: Record<string, unknown>;
  /** Extra vault files, relative path -> content. */
  files?: Record<string, string>;
  viewport?: { width: number; height: number };
  env?: Record<string, string>;
}
export interface AppHarness {
  app: ElectronApplication;
  page: Page;
  vault: string;
  openView(type: string): Promise<void>;
  close(): Promise<void>;
}

/** Starts the real Geode app (hidden, throwaway profile) with plugins loaded from folders. Requires `npm run build` at the repo root. */
export async function launchApp(opts: LaunchAppOptions): Promise<AppHarness> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "geode-plugin-test-"));
  const userData = path.join(base, "userdata");
  const vault = path.join(base, "vault");
  await fs.mkdir(userData, { recursive: true });
  for (const p of opts.plugins) {
    const dest = path.join(vault, ".geode/plugins", p.id);
    await fs.mkdir(dest, { recursive: true });
    for (const f of ["manifest.json", "main.js", "styles.css"]) {
      await fs.copyFile(path.join(p.dir, f), path.join(dest, f)).catch((e) => { if (f !== "styles.css") throw e; });
    }
    if (opts.pluginData?.[p.id]) await fs.writeFile(path.join(dest, "data.json"), JSON.stringify(opts.pluginData[p.id]));
  }
  await fs.mkdir(path.join(vault, ".geode"), { recursive: true });
  await fs.writeFile(path.join(vault, ".geode/plugins.json"), JSON.stringify(opts.plugins.map((p) => p.id)));
  await fs.writeFile(path.join(vault, "Welcome.md"), "hi");
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(vault, rel)), { recursive: true });
    await fs.writeFile(path.join(vault, rel), content);
  }
  await fs.writeFile(path.join(userData, "geode.json"), JSON.stringify({ lastVault: vault, recentVaults: [vault] }));
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userData}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    cwd: repoRoot,
    env: { ...process.env, GEODE_HEADLESS: "1", ...opts.env } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize(opts.viewport ?? { width: 1200, height: 800 });
  const logs: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text().slice(0, 400)}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${String(e).slice(0, 400)}`));
  try {
    await page.waitForFunction((ids) => ids.every((id) => !!(window as any).app?.pluginManager?.getPlugin(id)), opts.plugins.map((p) => p.id), { timeout: 30_000 });
  } catch (e) {
    const state = await page.evaluate(() => {
      const a = (window as any).app;
      return { hasApp: !!a, pm: a?.pluginManager ? Object.keys(a.pluginManager).slice(0, 20) : null, body: document.body.innerText.slice(0, 300) };
    }).catch((err) => String(err));
    throw new Error(`plugins did not load: ${JSON.stringify(state)}\n${logs.slice(0, 15).join("\n")}\n${String(e)}`);
  }
  return {
    app, page, vault,
    async openView(type) {
      await page.evaluate(async (t) => { await (window as any).app.workspace.getLeaf(true).setViewState({ type: t, active: true }); }, type);
      await page.waitForSelector(`.workspace-leaf-content[data-type="${type}"]`);
    },
    async close() { await app.close(); await fs.rm(base, { recursive: true, force: true }); },
  };
}
