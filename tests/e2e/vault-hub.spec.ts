import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function makeVault(prefix: string, note: string): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(vaultPath, `${note}.md`), `# ${note}\n`);
  return vaultPath;
}

const SLOW_STEP_PLUGIN = `const { Plugin } = require("obsidian");
module.exports = class extends Plugin {
  onload() {
    this.app.launch.registerStep({
      id: "e2e-hub:slow", title: "Creating sandbox", order: 1, optional: false,
      async run(ctx) { ctx.setProgress("pulling image"); await new Promise((r) => setTimeout(r, 2500)); },
    });
  }
};`;

function addSlowStepPlugin(vaultPath: string): void {
  const dir = path.join(vaultPath, ".geode", "plugins", "e2e-hub");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    id: "e2e-hub", name: "E2E Hub", version: "1.0.0", minAppVersion: "0.1.0", description: "Slow launch step.", author: "geode-tests",
  }));
  fs.writeFileSync(path.join(dir, "main.js"), SLOW_STEP_PLUGIN);
  fs.writeFileSync(path.join(vaultPath, ".geode", "plugins.json"), JSON.stringify(["e2e-hub"]));
}

async function stubChooseVault(window: Page, vaultPath: string): Promise<void> {
  await window.evaluate((chosen) => { window.geode.chooseVault = async () => chosen; }, vaultPath);
}

test("the hub opens from Manage vaults, moves focus with the arrow keys, and Esc or the close button returns to the workspace", async () => {
  const first = makeVault("geode-hub-first-", "First");
  const second = makeVault("geode-hub-second-", "Second");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hub-ud-"));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [first, second], lastVault: first }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator('.nav-file-title[data-path="First.md"]')).toBeVisible();
    const manage = window.getByRole("button", { name: "Manage vaults" });
    await manage.click();

    const hub = window.locator(".vault-hub");
    await expect(hub).toBeVisible();
    await expect(hub).toHaveAttribute("role", "dialog");
    await expect(hub.getByRole("heading", { name: "Geode" })).toBeVisible();
    await expect(hub).toContainText("Choose a vault to open");
    await expect(hub.locator(".vault-hub-card:not(.is-add)")).toHaveCount(2);
    await expect(hub.getByRole("button", { name: "Create new vault" })).toBeVisible();
    await expect(hub.getByRole("button", { name: "Open folder as vault" })).toBeVisible();
    // The registry has no last-opened time, no reveal-by-path, so the hub does not pretend to.
    await expect(hub).not.toContainText(/notes|Reveal|Opened/);

    // Avatar is a deterministic initial of the folder name.
    const currentCard = hub.locator(".vault-hub-card.is-current");
    await expect(currentCard).toContainText("Open in this window");
    await expect(currentCard.locator(".vault-hub-avatar")).toHaveText(path.basename(first)[0].toUpperCase());

    // Focus starts on the vault open here; arrows move across the grid.
    const mains = hub.locator(".vault-hub-card-main");
    await expect(mains.nth(0)).toBeFocused();
    await window.keyboard.press("ArrowRight");
    await expect(mains.nth(1)).toBeFocused();
    await window.keyboard.press("ArrowLeft");
    await expect(mains.nth(0)).toBeFocused();
    await window.keyboard.press("End");
    await expect(mains.last()).toBeFocused();

    // Hotkeys behind the hub do not fire while it is up.
    await window.keyboard.press(process.platform === "darwin" ? "Meta+P" : "Control+P");
    await expect(window.locator(".prompt-input")).toHaveCount(0);

    await window.keyboard.press("Escape");
    await expect(hub).toHaveCount(0);
    await expect(window.locator('.nav-file-title[data-path="First.md"]')).toBeVisible();
    await expect(manage).toBeFocused();

    await manage.click();
    await expect(hub).toBeVisible();
    await hub.getByRole("button", { name: "Close vault hub" }).click();
    await expect(hub).toHaveCount(0);

    // Clicking the vault that is already open just closes the hub.
    await manage.click();
    await hub.locator(".vault-hub-card.is-current .vault-hub-card-main").click();
    await expect(hub).toHaveCount(0);
    expect(app.windows().length).toBe(1);
  } finally {
    await app.close();
    for (const scratch of [first, second, userDataDir]) fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("clicking another vault's card morphs it and opens that vault in a new window", async () => {
  const first = makeVault("geode-hub-a-", "Alpha");
  const second = makeVault("geode-hub-b-", "Beta");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hub-ud-"));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [first, second], lastVault: first }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();
    await window.getByRole("button", { name: "Manage vaults" }).click();
    const hub = window.locator(".vault-hub");
    const card = hub.locator(".vault-hub-card", { hasText: second });

    const windowPromise = app.waitForEvent("window");
    await card.locator(".vault-hub-card-main").click();
    const newWindow = await windowPromise;
    await expect(newWindow.locator('.nav-file-title[data-path="Beta.md"]')).toBeVisible();
    await expect(hub).toHaveCount(0);
    await expect(window.locator('.nav-file-title[data-path="Alpha.md"]')).toBeVisible();
    expect(app.windows().length).toBe(2);
  } finally {
    await app.close();
    for (const scratch of [first, second, userDataDir]) fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the card menu offers Open in new window and Remove from list, and removing only forgets the vault", async () => {
  const first = makeVault("geode-hub-keep-", "Keep");
  const second = makeVault("geode-hub-drop-", "Drop");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hub-ud-"));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [first, second], lastVault: first }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator('.nav-file-title[data-path="Keep.md"]')).toBeVisible();
    await window.getByRole("button", { name: "Manage vaults" }).click();
    const hub = window.locator(".vault-hub");

    // The open vault has nothing to remove or reopen, so it has no menu.
    await expect(hub.locator(".vault-hub-card.is-current .vault-hub-more")).toHaveCount(0);

    const card = hub.locator(".vault-hub-card", { hasText: second });
    await card.hover();
    await card.getByRole("button", { name: /^Actions for/ }).click();
    const menu = hub.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText(["Open in new window", "Remove from list"]);
    await expect(menu.getByRole("menuitem", { name: /Reveal/ })).toHaveCount(0);

    await window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(hub).toBeVisible();

    await card.getByRole("button", { name: /^Actions for/ }).click();
    await menu.getByRole("menuitem", { name: "Remove from list" }).click();
    await expect(card).toHaveCount(0);
    await expect(hub.locator(".vault-hub-card:not(.is-add)")).toHaveCount(1);
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(userDataDir, "geode.json"), "utf8")).recentVaults).toEqual([first]);
    expect(fs.existsSync(path.join(second, "Drop.md"))).toBe(true);
  } finally {
    await app.close();
    for (const scratch of [first, second, userDataDir]) fs.rmSync(scratch, { recursive: true, force: true });
  }
});

for (const reducedMotion of [false, true]) {
  test(`first run: the hub is the only screen, and the chosen card becomes the launch progress (${reducedMotion ? "reduced motion" : "full motion"})`, async () => {
    const vaultPath = makeVault("geode-hub-launch-", "Launched");
    addSlowStepPlugin(vaultPath);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hub-ud-"));
    // No geode.json: a genuine first run.
    const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot, colorScheme: "dark" });
    try {
      const window = await app.firstWindow();
      if (reducedMotion) await window.emulateMedia({ reducedMotion: "reduce" });
      const hub = window.locator(".vault-hub");
      await expect(hub).toBeVisible();
      await expect(hub).toHaveClass(/is-empty/);
      await expect(hub).toContainText("Your knowledge base, on local Markdown files.");
      await expect(hub.locator(".vault-hub-card:not(.is-add)")).toHaveCount(0);
      await expect(hub.getByRole("button", { name: "Create new vault" })).toBeVisible();
      await expect(hub.getByRole("button", { name: "Try the sample vault" })).toBeVisible();
      await expect(hub.getByRole("button", { name: "Close vault hub" })).toHaveCount(0);

      await stubChooseVault(window, vaultPath);
      await hub.getByRole("button", { name: "Open folder as vault" }).click();

      const selected = hub.locator(".vault-hub-card.is-selected");
      await expect(selected).toBeVisible();
      await expect(selected).toContainText(path.basename(vaultPath));
      await expect(selected.locator(".launch-overlay-step.is-running .launch-overlay-step-title")).toHaveText("Creating sandbox", { timeout: 15_000 });
      await expect(selected.locator(".launch-overlay-step.is-running .launch-overlay-step-detail")).toHaveText("pulling image");
      // The siblings are gone and there is no second launch screen on top.
      await expect(hub.locator(".vault-hub-card:not(.is-selected):visible")).toHaveCount(0);
      await expect(window.locator(".launch-overlay")).toHaveCount(0);
      if (reducedMotion) {
        expect(await selected.evaluate((el) => el.getAnimations().length)).toBe(0);
      }

      await expect(hub).toHaveCount(0, { timeout: 15_000 });
      await expect(window.locator(".workspace")).toBeVisible();
      await expect(window.locator('.nav-file-title[data-path="Launched.md"]')).toBeVisible();
    } finally {
      await app.close();
      fs.rmSync(vaultPath, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}
