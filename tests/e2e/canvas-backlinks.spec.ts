import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("shows Canvas note cards as readable backlinks and opens their Canvas source", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-backlinks-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-backlinks-user-"));
  fs.mkdirSync(path.join(vaultDir, "Notes"));
  fs.mkdirSync(path.join(vaultDir, "Boards"));
  fs.writeFileSync(path.join(vaultDir, "Notes", "Target.md"), "# Target\n");
  fs.writeFileSync(path.join(vaultDir, "Boards", "Board.canvas"), JSON.stringify({
    vendorDocument: "raw JSON noise",
    nodes: [
      { id: "first", type: "file", x: 0, y: 0, width: 220, height: 120, file: "Notes/Target.md", subpath: "#First" },
      { id: "text", type: "text", x: 0, y: 180, width: 220, height: 120, text: "[[Notes/Target.md]] must not become a backlink" },
      { id: "second", type: "file", x: 280, y: 0, width: 220, height: 120, file: "Notes/Target.md", subpath: "#Second" },
    ],
    edges: [],
  }, null, 2));
  fs.writeFileSync(path.join(vaultDir, "Boards", "Malformed.canvas"), '{"nodes":[{"file":"Notes/Target.md"}]');
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));
    await window.locator('.nav-folder-title[data-path="Notes"]').click();
    await window.locator('.nav-file-title[data-path="Notes/Target.md"]').click();

    const backlinks = window.getByText("Backlinks", { exact: true }).locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' sidebar-view ')][1]",
    );
    await expect(backlinks.getByText("Linked mentions (2)", { exact: true })).toBeVisible();
    const source = backlinks.locator(".pane-result", { hasText: "Board" });
    await expect(source).toBeVisible();
    await expect(source.locator(".pane-result-count")).toHaveText("2");
    const contexts = backlinks.locator(".pane-result-context");
    await expect(contexts).toHaveText([
      "Note card: Notes/Target.md#First",
      "Note card: Notes/Target.md#Second",
    ]);
    expect((await backlinks.innerText())).not.toContain("raw JSON noise");
    expect((await backlinks.innerText())).not.toContain("must not become a backlink");

    await source.click();
    await expect(window.locator(".canvas-view .view-header-title")).toHaveText("Board");
    await expect(window.locator('.canvas-node[data-node-id="first"]')).toBeVisible();
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
