import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("defers Backlinks work while hidden and refreshes it when revealed", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-backlinks-visibility-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-backlinks-visibility-ud-"));
  fs.writeFileSync(path.join(vaultDir, "A.md"), "# A\n\nPlain mention of B for context.\n");
  fs.writeFileSync(path.join(vaultDir, "B.md"), "# B\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    await expect(window.locator('.nav-file-title[data-path="A.md"]')).toBeVisible();

    // Backlinks is the right sidebar's initial view. Switch to Outline so
    // subsequent file activations must not run Backlinks' vault-wide scan.
    await window.locator('.workspace-sidebar.mod-right [data-type="outline"]').click();
    await expect(window.locator(".workspace-sidebar.mod-right .sidebar-view-title")).toHaveText("Outline");

    await window.evaluate(() => {
      const geode = (window as any).app;
      const scanSymbol = Object.getOwnPropertySymbols(Object.getPrototypeOf(geode.metadataCache))
        .find((symbol) => symbol.description === "geode.unlinkedMentionsScan");
      if (!scanSymbol) throw new Error("cancellable unlinked-mention scan entry point was not found");
      const original = geode.metadataCache[scanSymbol].bind(geode.metadataCache);
      (window as any).__unlinkedMentionCalls = [];
      geode.metadataCache[scanSymbol] = (file: { path: string }, options: { signal?: AbortSignal }) => {
        (window as any).__unlinkedMentionCalls.push(file.path);
        return original(file, options);
      };
    });

    await window.evaluate(async () => {
      const geode = (window as any).app;
      await geode.openFile(geode.vault.getFileByPath("A.md"), true);
    });
    expect(await window.evaluate(() => (window as any).__unlinkedMentionCalls)).toEqual([]);

    // A metadata render already queued while Backlinks was visible must also
    // re-check visibility when its microtask eventually runs.
    await window.evaluate(async () => {
      const geode = (window as any).app;
      geode.metadataCache.trigger("changed", geode.vault.getFileByPath("A.md"));
      await Promise.resolve();
    });
    expect(await window.evaluate(() => (window as any).__unlinkedMentionCalls)).toEqual([]);

    await window.evaluate(async () => {
      const geode = (window as any).app;
      await geode.openFile(geode.vault.getFileByPath("B.md"), true);
    });

    expect(await window.evaluate(() => (window as any).__unlinkedMentionCalls)).toEqual([]);

    // Revealing Backlinks computes the deferred state for the active file.
    await window.locator('.workspace-sidebar.mod-right [data-type="backlinks"]').click();
    await expect(window.locator(".workspace-sidebar.mod-right .sidebar-view-title")).toHaveText("Backlinks");
    await expect(
      window.locator(".workspace-sidebar.mod-right .pane-section-header", { hasText: "Unlinked mentions (1)" })
    ).toBeVisible();
    await expect(window.locator(".workspace-sidebar.mod-right .pane-result", { hasText: "A" })).toBeVisible();
    await expect(
      window.locator(".workspace-sidebar.mod-right .pane-result-context", { hasText: "Plain mention of B for context." })
    ).toBeVisible();
    expect(await window.evaluate(() => (window as any).__unlinkedMentionCalls)).toEqual(["B.md"]);

    // While visible it continues to refresh synchronously for the newly active file.
    await window.evaluate(() => {
      const geode = (window as any).app;
      return geode.openFile(geode.vault.getFileByPath("A.md"), false);
    });
    await expect(
      window.locator(".workspace-sidebar.mod-right .pane-section-header", { hasText: "Unlinked mentions (0)" })
    ).toBeVisible();
    expect(await window.evaluate(() => (window as any).__unlinkedMentionCalls)).toEqual(["B.md", "A.md"]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
