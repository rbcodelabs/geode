#!/usr/bin/env node
/**
 * Screenshots each modal surface touched by the parity pass. Run once against
 * the current tree and once against a reverted `styles/app.css` to get a
 * comparable before/after pair.
 *
 *   node scripts/modal-shots.mts <outDir>
 *
 * Alongside each PNG it writes measurements.json (padding, bounding box, offset
 * from the viewport centre, scrim width), so modal geometry can be diffed
 * numerically rather than by eye. Not part of the test suite — the assertions
 * that must not regress live in tests/e2e/modal-parity.spec.ts.
 */
import { _electron as electron } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] ?? "/tmp/modal-shots");
fs.mkdirSync(outDir, { recursive: true });

const fixtureDir = path.join(repoRoot, "tests", "fixtures", "plugins", "modal-parity");

// A handful of extra vaults so the Manage vaults list is long enough to scroll.
const vaults = Array.from({ length: 12 }, (_, i) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `geode-shot-v${i}-`));
  fs.writeFileSync(path.join(dir, "Note.md"), `# Vault ${i}\n`);
  return dir;
});
const vaultDir = vaults[0];
const pluginDir = path.join(vaultDir, ".geode", "plugins", "modal-parity-probe");
fs.mkdirSync(pluginDir, { recursive: true });
for (const name of ["manifest.json", "main.js"]) {
  fs.copyFileSync(path.join(fixtureDir, name), path.join(pluginDir, name));
}
fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify(["modal-parity-probe"]));

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-shot-ud-"));
fs.writeFileSync(
  path.join(userDataDir, "geode.json"),
  JSON.stringify({ recentVaults: vaults, lastVault: vaultDir })
);

const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
const win = await app.firstWindow();
await win.waitForFunction(() => !!(globalThis as any).app?.workspace);
await win.setViewportSize({ width: 1100, height: 700 });

const measurements: Record<string, unknown> = {};

async function shoot(name: string, open: () => Promise<void>) {
  await open();
  await win.locator(".modal-container").first().waitFor({ state: "visible" });
  await win.waitForTimeout(350); // let layout/fonts settle
  await win.screenshot({ path: path.join(outDir, `${name}.png`) });
  measurements[name] = await win.evaluate(() => {
    const modal = document.querySelector(".modal") as HTMLElement | null;
    if (!modal) return null;
    const r = modal.getBoundingClientRect();
    const cs = getComputedStyle(modal);
    const bg = document.querySelector(".modal-bg");
    return {
      padding: cs.padding,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      centreOffsetX: Math.round(r.x + r.width / 2 - window.innerWidth / 2),
      scrimWidth: bg ? Math.round(bg.getBoundingClientRect().width) : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
  await win.evaluate(() => {
    document.querySelectorAll(".modal-container").forEach((el) => el.remove());
  });
  await win.waitForTimeout(150);
}

await shoot("manage-vaults", async () => {
  await win.getByRole("button", { name: "Manage vaults" }).click();
});
await shoot("settings", async () => {
  await win.evaluate(() => (globalThis as any).app.setting.openTabById("appearance"));
});
await shoot("command-palette", async () => {
  await win.evaluate(() => (globalThis as any).app.commands.executeCommandById("command-palette"));
});
await shoot("plugin-modal", async () => {
  await win.evaluate(() => (globalThis as any).__modalParityProbe.open());
});

fs.writeFileSync(path.join(outDir, "measurements.json"), JSON.stringify(measurements, null, 2));
console.log(JSON.stringify(measurements, null, 2));

await app.close();
for (const dir of [...vaults, userDataDir]) fs.rmSync(dir, { recursive: true, force: true });
