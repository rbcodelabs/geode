import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listVaultFiles } from "../../src/main/vault-files";

const temporaryRoots: string[] = [];

function makeVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-files-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("listVaultFiles", () => {
  it("preserves recursive file/folder metadata and excludes hidden entries", async () => {
    const root = makeVault();
    fs.mkdirSync(path.join(root, "Folder"));
    fs.writeFileSync(path.join(root, "visible.md"), "visible");
    fs.writeFileSync(path.join(root, "Folder", "nested.md"), "nested content");
    fs.writeFileSync(path.join(root, ".hidden.md"), "hidden");
    fs.mkdirSync(path.join(root, ".geode"));
    fs.writeFileSync(path.join(root, ".geode", "config.json"), "{}");

    const entries = await listVaultFiles(root);

    expect(entries.map(({ path: entryPath }) => entryPath).sort()).toEqual([
      "Folder",
      "Folder/nested.md",
      "visible.md",
    ]);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "Folder", isFolder: true, size: 0 }),
      expect.objectContaining({ path: "Folder/nested.md", isFolder: false, size: 14 }),
      expect.objectContaining({ path: "visible.md", isFolder: false, size: 7 }),
    ]));
    for (const entry of entries) {
      expect(entry.mtime).toBeGreaterThan(0);
      expect(entry.ctime).toBeGreaterThan(0);
    }
  });

  it("lets unrelated main-loop work interleave with a delayed large traversal", async () => {
    const root = makeVault();
    for (let index = 0; index < 160; index += 1) {
      fs.writeFileSync(path.join(root, `Note-${index}.md`), `# Note ${index}\n`);
    }

    let traversalSettled = false;
    let interleavedWhileWalking = false;
    let yieldCount = 0;
    const traversal = listVaultFiles(root, {
      ioDelayMs: 1,
      yieldEveryOperations: 16,
      yieldToEventLoop: async () => {
        yieldCount += 1;
        await new Promise<void>((resolve) => setImmediate(() => {
          // This callback stands in for an unrelated Electron main-process
          // task such as dispatching plugin-file-read IPC.
          interleavedWhileWalking ||= !traversalSettled;
          resolve();
        }));
      },
    }).finally(() => {
      traversalSettled = true;
    });

    const entries = await traversal;

    expect(yieldCount).toBeGreaterThan(1);
    expect(interleavedWhileWalking).toBe(true);
    expect(entries).toHaveLength(160);
    expect(entries.every((entry) => !entry.isFolder && entry.size > 0)).toBe(true);
  });
});
