import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("Manage vaults (Vault Hub) opens and focuses isolated vault windows", async () => {
  const firstVault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-switch-first-"));
  const secondVault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-switch-second-"));
  const missingVault = path.join(os.tmpdir(), `geode-switch-missing-${Date.now()}`);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-switch-ud-"));
  fs.writeFileSync(path.join(firstVault, "First.md"), "# First\n");
  fs.writeFileSync(path.join(secondVault, "Second.md"), "# Second\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({
    recentVaults: [firstVault, missingVault, secondVault],
    lastVault: firstVault,
  }));

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const firstWindow = await app.firstWindow();
    await expect(firstWindow.locator('.nav-file-title[data-path="First.md"]')).toBeVisible();
    const firstBrowserWindow = await app.browserWindow(firstWindow);
    await expect.poll(() => firstBrowserWindow.evaluate((win: any) => win.getTitle()))
      .toBe(`${path.basename(firstVault)} — Geode`);

    const manageButton = firstWindow.getByRole("button", { name: "Manage vaults" });
    await expect(manageButton).toBeVisible();
    await manageButton.click();

    const hub = firstWindow.locator(".vault-hub");
    await expect(hub.getByRole("heading", { name: "Geode" })).toBeVisible();
    await expect(hub).toContainText("Choose a vault to open");
    const currentCard = hub.locator(".vault-hub-card", { hasText: firstVault });
    await expect(currentCard).toContainText("Open in this window");
    await expect(hub).not.toContainText(missingVault);
    const openFolderButton = hub.getByRole("button", { name: "Open folder as vault" });
    await expect(openFolderButton).toBeVisible();

    // Native folder-picker cancellation is a no-op: keep this vault and the hub intact.
    await firstWindow.evaluate(() => {
      const geode = window.geode;
      (window as any).__originalChooseVault = geode.chooseVault;
      geode.chooseVault = async () => null;
    });
    await openFolderButton.click();
    await expect(hub).toBeVisible();
    await expect(hub.locator(".is-opening")).toHaveCount(0);
    await expect.poll(() => app.windows().length).toBe(1);
    // Main-process validation rejects missing folders without changing this window.
    await expect(firstWindow.evaluate((vaultPath) => window.geode.openVaultWindow(vaultPath), missingVault))
      .rejects.toThrow("Not a folder");
    await expect(firstWindow.locator('.nav-file-title[data-path="First.md"]')).toBeVisible();
    await expect.poll(() => app.windows().length).toBe(1);

    // A successful native selection uses the explicit launch target rather than
    // mutating recentVaults[0] and racing the new renderer's startup.
    await firstWindow.evaluate((vaultPath) => {
      window.geode.chooseVault = async () => vaultPath;
    }, secondVault);
    const pagePromise = app.waitForEvent("window");
    await openFolderButton.click();
    const secondWindow = await pagePromise;
    await expect(secondWindow.locator('.nav-file-title[data-path="Second.md"]')).toBeVisible();
    const secondBrowserWindow = await app.browserWindow(secondWindow);
    await expect.poll(() => secondBrowserWindow.evaluate((win: any) => win.getTitle()))
      .toBe(`${path.basename(secondVault)} — Geode`);
    await expect(firstWindow.locator('.nav-file-title[data-path="First.md"]')).toBeVisible();

    await secondWindow.getByRole("button", { name: "Manage vaults" }).click();
    await secondWindow.locator(".vault-hub-card", { hasText: firstVault }).locator(".vault-hub-card-main").click();
    await expect(secondWindow.locator(".vault-hub")).toHaveCount(0);
    await expect.poll(() => app.windows().length).toBe(2);

    await firstWindow.getByRole("button", { name: "Manage vaults" }).click();
    await firstWindow.locator(".vault-hub-card", { hasText: firstVault }).locator(".vault-hub-card-main").click();
    await expect(firstWindow.locator(".vault-hub")).toHaveCount(0);
    await expect.poll(() => app.windows().length).toBe(2);

    await firstWindow.keyboard.press(process.platform === "darwin" ? "Meta+P" : "Control+P");
    await firstWindow.locator(".prompt-input").fill("Open another vault");
    await expect(firstWindow.locator(".prompt-result", { hasText: "Open another vault" })).toBeVisible();
  } finally {
    await app.close();
    for (const scratchPath of [firstVault, secondVault, userDataDir]) {
      fs.rmSync(scratchPath, { recursive: true, force: true });
    }
  }
});

test("a long vault list scrolls inside the hub and keeps the open-folder card reachable", async () => {
  // The hub is a full-window overlay. With enough recent vaults the grid is taller than the
  // window (the registry keeps ten recents), so the overlay itself must scroll or the tail of the list and the dashed
  // "Open folder as vault" card sit below the fold with no way to reach them.
  const vaults = Array.from({ length: 10 }, (_, index) => {
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), `geode-many-${index}-`));
    fs.writeFileSync(path.join(vaultPath, "Note.md"), `# Vault ${index}\n`);
    return vaultPath;
  });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-many-ud-"));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({
    recentVaults: vaults,
    lastVault: vaults[0],
  }));

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    await expect(window.locator('.nav-file-title[data-path="Note.md"]')).toBeVisible();
    await window.setViewportSize({ width: 1100, height: 520 });
    await window.getByRole("button", { name: "Manage vaults" }).click();

    const hub = window.locator(".vault-hub");
    await expect(hub.getByRole("heading", { name: "Geode" })).toBeVisible();
    await expect(hub.locator(".vault-hub-card:not(.is-add)")).toHaveCount(10);

    const scroll = await hub.evaluate((el) => {
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      return { overflowY: getComputedStyle(el).overflowY, before, after: el.scrollTop };
    });
    expect(scroll.overflowY).toBe("auto");
    expect(scroll.after).toBeGreaterThan(scroll.before);

    const reachable = await hub.evaluate((el) => {
      const cards = [...el.querySelectorAll(".vault-hub-card:not(.is-add)")];
      const openFolder = el.querySelector('.vault-hub-card.is-add[data-action="open-folder"]')!;
      const within = (node: Element) => {
        const rect = node.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight + 1;
      };
      return { lastCard: within(cards[cards.length - 1]), openFolder: within(openFolder) };
    });
    expect(reachable).toEqual({ lastCard: true, openFolder: true });
  } finally {
    await app.close();
    for (const scratchPath of [...vaults, userDataDir]) {
      fs.rmSync(scratchPath, { recursive: true, force: true });
    }
  }
});
