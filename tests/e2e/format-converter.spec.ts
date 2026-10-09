import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("Format converter converts a fixture vault from the modal", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-fmtconv-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-fmtconv-e2e-"));
  const note = path.join(vaultDir, "Imported.md");
  fs.writeFileSync(
    note,
    [
      "---",
      "alias: Old Name",
      "tag: one, two",
      "cssclass: wide",
      "---",
      "# Heading",
      "Roam #idea and #[[big idea]] with ^^marked^^ text.",
      "- {{[[TODO]]}} write it",
      "Bear ::shiny:: text and `#code ^^kept^^`.",
      "See [[202401021530]].",
      "",
    ].join("\n")
  );
  fs.writeFileSync(path.join(vaultDir, "202401021530 My Zettel.md"), "zettel\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_HEADLESS: "1" },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);

    // Off by default: no ribbon icon, no command.
    await expect(win.locator(".format-converter-ribbon")).toHaveCount(0);

    // Enable from Settings -> Core plugins.
    await win.evaluate(() => (window as any).app.setting.openTabById("core-plugins"));
    await win.getByLabel("Enable Format converter").check();
    await win.keyboard.press("Escape");

    await expect(win.locator(".format-converter-ribbon")).toHaveCount(1);
    const hasCommand = await win.evaluate(() =>
      Object.keys((window as any).app.commands?.commands ?? {}).some((id) => id.endsWith("format-converter:open"))
    );
    expect(hasCommand).toBe(true);

    await win.locator(".format-converter-ribbon").click();
    const modal = win.locator(".format-converter-modal");
    await expect(modal).toContainText("Back up your vault");
    // Nothing selected -> nothing to start.
    await expect(modal.locator(".format-converter-start")).toBeDisabled();

    for (const label of [
      "Convert #tag and #[[tag]] to [[tag]]",
      "Convert ^^highlight^^ to ==highlight==",
      "Convert {{[[TODO]]}} to [ ]",
      "Convert ::highlight:: to ==highlight==",
      "Convert [[UID]] links to include the file name",
      "Convert alias, tag and cssclass to aliases, tags and cssclasses lists",
    ]) {
      await modal.getByLabel(label).check();
    }
    await modal.getByLabel("Zettelkasten link style").selectOption("pretty");
    await modal.locator(".format-converter-start").click();
    await expect(modal.locator(".format-converter-status")).toContainText("Converted 1 of 2 notes.");

    await expect
      .poll(() => fs.readFileSync(note, "utf8"))
      .toBe(
        [
          "---",
          "aliases:",
          "  - Old Name",
          "tags:",
          "  - one",
          "  - two",
          "cssclasses:",
          "  - wide",
          "---",
          "# Heading",
          "Roam [[idea]] and [[big idea]] with ==marked== text.",
          "- [ ] write it",
          "Bear ==shiny== text and `#code ^^kept^^`.",
          "See [[202401021530 My Zettel|My Zettel]].",
          "",
        ].join("\n")
      );
    expect(fs.readFileSync(path.join(vaultDir, "202401021530 My Zettel.md"), "utf8")).toBe("zettel\n");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
