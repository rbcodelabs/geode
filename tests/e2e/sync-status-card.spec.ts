import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const root = path.resolve(__dirname, "../..");

test("the Sync tab leads with a status card and folds its settings into sections", async ({}, info) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sync-card-")); const profile = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sync-card-profile-"));
  fs.writeFileSync(path.join(vault, "Note.md"), "local"); fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root });
  try {
    const page = await app.firstWindow(); await page.waitForFunction(() => Boolean((window as any).app?.workspace));
    await page.evaluate(() => {
      const app = (window as any).app;
      const descriptor = { schema: 1, protocol: "append-only-history-v1", vaultId: "12345678-1234-4234-8234-123456789012", rootId: "synthetic-root", descriptorId: "synthetic-descriptor", name: "Synthetic shared vault" };
      app.sync.register("synthetic-fixture", { id: "history.fixture", name: "Immutable fixture", protocol: "append-only-history-v1", capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
        discover: async () => [descriptor], createVault: async () => descriptor, open: async () => ({ scan: async () => ({ status: "complete", records: [] }), close: async () => {} }),
      }); app.setting.openTabById("sync");
    });
    const modal = page.locator('.modal.mod-settings[aria-label="Settings"]');
    const card = modal.locator(".sync-status-card");

    // Not connected: the card says so and the one emphasised action is setup, with Connection open to act on it.
    await expect(card).toContainText("Sync is not set up");
    await expect(card).toHaveAttribute("data-tone", "idle");
    await expect(card.getByRole("button", { name: "Set up sync" })).toHaveClass(/mod-cta/);
    await expect(modal.getByRole("button", { name: /^Connection/ })).toHaveAttribute("aria-expanded", "true");

    // Connect and create: the card moves on to the preview step with a count chip once a preview exists.
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("history.fixture");
    // Guided setup: two separate choices, each owning its own controls (the name box belongs to "start a new" only).
    const startNew = modal.getByRole("group", { name: "Start a new shared vault" });
    const joinExisting = modal.getByRole("group", { name: "Join an existing shared vault" });
    await expect(startNew.getByRole("textbox", { name: "Shared vault name" })).toBeVisible();
    await expect(startNew.getByRole("button", { name: "Create shared vault" })).toBeVisible();
    await expect(joinExisting.getByRole("button", { name: "Find shared vaults" })).toBeVisible();
    await expect(joinExisting.getByRole("textbox")).toHaveCount(0);
    // Until a vault exists the card must not offer to approve a sync: it says setup is needed and points at it.
    await expect(card).toContainText("Setup needed");
    await expect(card.getByRole("button", { name: "Set up sync" })).toHaveClass(/mod-cta/);
    await page.screenshot({ path: info.outputPath("sync-setup-unbound.png") });
    await startNew.getByRole("textbox", { name: "Shared vault name" }).fill("Synthetic shared vault");
    await startNew.getByRole("button", { name: "Create shared vault", exact: true }).click();
    // Once bound, the create/join choices fold away behind "Change shared vault".
    await expect(modal.getByRole("button", { name: "Change shared vault" })).toBeVisible();
    await expect(modal.getByRole("textbox", { name: "Shared vault name" })).toBeHidden();
    await modal.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(card.locator(".sync-status-count")).toContainText(/[1-9]\d* to upload/);

    // Sections: the user's own toggle sticks, and What syncs reports a live "n of 13" summary.
    const connection = modal.getByRole("button", { name: /^Connection/ });
    await connection.click();
    await expect(connection).toHaveAttribute("aria-expanded", "false");
    await expect(modal.getByRole("combobox", { name: "Sync provider" })).toBeHidden();
    await connection.click();
    await expect(modal.getByRole("combobox", { name: "Sync provider" })).toBeVisible();

    const scope = modal.getByRole("button", { name: /^What syncs/ });
    await expect(scope).toHaveAttribute("aria-expanded", "false");
    await expect(scope).toContainText(/\d+ of 13 syncing/);
    const before = Number(/(\d+) of 13/.exec((await scope.textContent()) ?? "")?.[1]);
    await scope.click();
    const images = modal.getByRole("checkbox", { name: "Images", exact: true });
    const wasChecked = await images.isChecked();
    await images.setChecked(!wasChecked);
    await expect(scope).toContainText(`${before + (wasChecked ? -1 : 1)} of 13 syncing`);

    // Nothing is wrong, so the issues section stays closed and says so.
    const issues = modal.getByRole("button", { name: /^Conflicts & issues/ });
    await expect(issues).toHaveAttribute("aria-expanded", "false");
    await expect(issues).toContainText("Nothing needs attention");
    await page.screenshot({ path: info.outputPath("sync-status-card.png") });
  } finally { await app.close(); fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); }
});
