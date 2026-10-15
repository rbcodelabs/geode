import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
test("Vault copy preserves attachment and BOM bytes through the host and traversal includes each root", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-copy-fixture-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-copy-ud-"));
  const binary = Buffer.from([0, 255, 254, 128, 192, 175]);
  const markdown = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("# Café\r\n\r\n[[Target]]\r\n")]);
  fs.mkdirSync(path.join(vaultDir, "Docs"));
  fs.writeFileSync(path.join(vaultDir, "attachment.bin"), binary);
  fs.writeFileSync(path.join(vaultDir, "Docs/Note.md"), markdown);
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    const result = await window.evaluate(async () => {
      const vault = (window as any).app.vault;
      const created: string[] = [];
      const stop = vault.on("create", (file: { path: string }) => created.push(file.path));
      const attachment = await vault.copy(vault.getFileByPath("attachment.bin"), "Docs/copied.bin");
      const note = await vault.copy(vault.getFileByPath("Docs/Note.md"), "Copied.md");
      stop();
      const paths: string[] = [];
      vault.constructor.recurseChildren(vault.getRoot(), (file: { path: string }) => paths.push(file.path));
      return { attachmentSize: attachment.size, noteSize: note.size, created, paths };
    });
    expect(fs.readFileSync(path.join(vaultDir, "Docs/copied.bin"))).toEqual(binary);
    expect(fs.readFileSync(path.join(vaultDir, "Copied.md"))).toEqual(markdown);
    expect(result.attachmentSize).toBe(binary.byteLength); expect(result.noteSize).toBe(markdown.byteLength);
    expect(result.created).toEqual(["Docs/copied.bin", "Copied.md"]);
    expect(result.paths[0]).toBe("");
    expect(new Set(result.paths).size).toBe(result.paths.length);
    expect(result.paths).toEqual(expect.arrayContaining(["Docs", "Docs/Note.md", "Docs/copied.bin", "Copied.md", "attachment.bin"]));
  } finally {
    await app.close(); fs.rmSync(vaultDir, { recursive: true, force: true }); fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
