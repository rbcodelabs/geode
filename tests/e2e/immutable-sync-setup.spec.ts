import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
const root = path.resolve(__dirname, "../..");
test("immutable setup requires explicit create and preview through real settings", async ({}, info) => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-history-ui-")); const profile = fs.mkdtempSync(path.join(os.tmpdir(), "geode-history-profile-"));
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
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("history.fixture");
    await modal.getByRole("textbox", { name: "Shared vault name" }).fill("Synthetic shared vault");
    await modal.getByRole("button", { name: "Create shared vault", exact: true }).click();
    await expect(modal).toContainText("Shared vault created");
    await modal.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(modal).toContainText("upload");
    expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe("local");
    await page.setViewportSize({ width: 800, height: 800 }); await page.screenshot({ path: info.outputPath("immutable-setup-small.png") });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: info.outputPath("immutable-setup-large.png") });
  } finally { await app.close(); fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); }
});
