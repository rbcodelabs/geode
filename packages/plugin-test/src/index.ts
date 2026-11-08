import { chromium, type Browser, type BrowserType, type Page } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import type { HarnessSeed } from "./setup";

const here = __dirname;
const root = path.resolve(here, "../../..");
const ORIGIN = "http://localhost:4173"; // must be a secure origin: crypto.randomUUID is missing on fake origins

export interface PluginSource { id: string; /** Directory holding manifest.json, main.js and optionally styles.css */ dir: string }
export interface LaunchOptions extends Omit<HarnessSeed, "enabledPlugins"> {
  plugins?: PluginSource[];
  viewport?: { width: number; height: number };
  browser?: Browser;
  executablePath?: string;
}
export interface Harness {
  page: Page;
  /** Errors seen in the page (console errors + uncaught exceptions). */
  errors: string[];
  /** Open a registered view type in a new leaf and wait for it to attach. */
  openView(type: string): Promise<void>;
  close(): Promise<void>;
}

export async function launchPlugin(opts: LaunchOptions = {}): Promise<Harness> {
  const bundle = path.join(here, "../dist/harness.js");
  if (!fs.existsSync(bundle)) throw new Error("plugin-test: dist/harness.js missing — run `npm run build -w packages/plugin-test` first");
  const files: Record<string, string> = { ...(opts.files ?? {}) };
  for (const p of opts.plugins ?? []) {
    for (const f of ["manifest.json", "main.js", "styles.css"]) {
      const src = path.join(p.dir, f);
      if (fs.existsSync(src)) files[`.geode/plugins/${p.id}/${f}`] = fs.readFileSync(src, "utf8");
    }
  }
  const css = fs.readFileSync(path.join(root, "styles/app.css"), "utf8");
  const html = `<!doctype html><html><head><meta charset=utf-8><style>${css}</style></head><body class="theme-light"><div id="app"></div></body></html>`;

  const owned = !opts.browser;
  const browser = opts.browser ?? await (chromium as BrowserType).launch({ executablePath: opts.executablePath ?? (process.env.CHROME || undefined) });
  const page = await browser.newPage({ viewport: opts.viewport ?? { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route(`${ORIGIN}/**`, (r) => r.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${ORIGIN}/`);
  const seed: HarnessSeed = { vaultName: opts.vaultName, files, mobile: opts.mobile, enabledPlugins: (opts.plugins ?? []).map((p) => p.id) };
  await page.evaluate((s) => { (window as any).__geodeSeed = s; }, seed);
  await page.addScriptTag({ content: fs.readFileSync(bundle, "utf8") });
  await page.waitForFunction(() => (window as any).app?.workspace, null, { timeout: 20_000 });
  for (const p of opts.plugins ?? []) {
    await page.waitForFunction((id) => !!(window as any).app.plugins?.plugins?.[id], p.id, { timeout: 20_000 });
  }
  return {
    page, errors,
    async openView(type) {
      await page.evaluate(async (t) => { await (window as any).app.workspace.getLeaf(true).setViewState({ type: t, active: true }); }, type);
      await page.waitForSelector(`.workspace-leaf-content[data-type="${type}"]`);
    },
    async close() { await page.close(); if (owned) await browser.close(); },
  };
}
export { launchApp, type AppHarness, type LaunchAppOptions } from "./launch-app";
