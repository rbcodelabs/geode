import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Covers the vault picker's "Create new vault" modal (src/renderer/app.ts's
 * `showCreateVaultModal`, src/main/create-vault.ts). `GEODE_DOCUMENTS_DIR`
 * redirects the default location to a scratch dir.
 */
test("Create new vault makes the folder, opens it, and reports collisions inline", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-create-vault-ud-"));
  const documentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-create-vault-docs-"));
  fs.mkdirSync(path.join(documentsDir, "Taken"));

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_DOCUMENTS_DIR: documentsDir },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.locator(".vault-picker")).toBeVisible();
    await window.getByRole("button", { name: "Create new vault" }).click();

    const dialog = window.getByRole("dialog", { name: "Create new vault" });
    await expect(dialog).toBeVisible();
    const nameInput = dialog.getByLabel("Vault name");
    await expect(nameInput).toBeFocused();
    await expect(nameInput).toHaveValue("My vault");
    await expect(dialog.locator(".vault-create-preview")).toContainText("My vault");

    // Invalid name disables Create and shows an inline message.
    const createButton = dialog.getByRole("button", { name: "Create", exact: true });
    await nameInput.fill("a/b");
    await expect(createButton).toBeDisabled();
    await expect(dialog.getByRole("alert")).toContainText("can't contain");

    // Collision with an existing folder: error, nothing overwritten, no open.
    await nameInput.fill("Taken");
    await createButton.click();
    await expect(dialog.getByRole("alert")).toContainText("A folder named Taken already exists");
    await expect(dialog).toBeVisible();

    // Escape cancels; reopen and create for real.
    await window.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await window.getByRole("button", { name: "Create new vault" }).click();
    await window.getByLabel("Vault name").fill("Fresh Vault");
    await window.getByLabel("Vault name").press("Enter");

    await expect(window.locator(".app-shell")).toBeVisible();
    const created = path.join(documentsDir, "Fresh Vault");
    expect(fs.statSync(created).isDirectory()).toBe(true);
    await expect(window.locator(".vault-picker")).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(documentsDir, { recursive: true, force: true });
  }
});
