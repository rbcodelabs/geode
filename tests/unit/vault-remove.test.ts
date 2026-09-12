import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveVaultPath } from "../../src/main/vault-path";
import {
  removeVaultFolder,
  resolveVaultFolderPath,
} from "../../src/main/vault-remove";

/**
 * Backing for Obsidian's `adapter.rmdir(normalizedPath, recursive)`, which
 * Geode had no implementation of at all — the call threw, plugins swallowed
 * it, and the folder leaked on disk forever (obsidian-claude-threads cleans up
 * a thread's attachment folder this way).
 *
 * The boundary checks matter more than the removal: this is a recursive,
 * permanent delete driven by a path a plugin chose, so the vault root is the
 * hard edge.
 */

const roots: string[] = [];
function makeVault(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "geode-rmdir-")));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveVaultPath (the shared vault boundary)", () => {
  const root = "/vault";

  it("resolves an ordinary relative path under the root", () => {
    expect(resolveVaultPath(root, "Notes/Attachments")).toBe("/vault/Notes/Attachments");
  });

  it("refuses a path that climbs out of the vault", () => {
    expect(() => resolveVaultPath(root, "../outside")).toThrow(/Path escapes vault/);
    expect(() => resolveVaultPath(root, "Notes/../../outside")).toThrow(/Path escapes vault/);
    expect(() => resolveVaultPath(root, "../vault-sibling")).toThrow(/Path escapes vault/);
  });

  it("refuses an absolute path outside the vault", () => {
    expect(() => resolveVaultPath(root, "/etc/passwd")).toThrow(/Path escapes vault/);
  });

  it("does not treat a sibling directory sharing a name prefix as inside", () => {
    expect(() => resolveVaultPath("/vault", "../vaultmore/x")).toThrow(/Path escapes vault/);
  });
});

describe("resolveVaultFolderPath", () => {
  it("refuses the vault root itself in every spelling", () => {
    expect(() => resolveVaultFolderPath("/vault", "")).toThrow(/refusing to remove the vault root/);
    expect(() => resolveVaultFolderPath("/vault", ".")).toThrow(/refusing to remove the vault root/);
    expect(() => resolveVaultFolderPath("/vault", "Notes/..")).toThrow(/refusing to remove the vault root/);
  });

  it("still resolves real folders", () => {
    expect(resolveVaultFolderPath("/vault", "Notes/Attachments")).toBe("/vault/Notes/Attachments");
  });
});

describe("removeVaultFolder", () => {
  it("removes an empty folder without recursive", async () => {
    const root = makeVault();
    fs.mkdirSync(path.join(root, "Empty"));

    await removeVaultFolder(root, "Empty", false);

    expect(fs.existsSync(path.join(root, "Empty"))).toBe(false);
  });

  it("refuses a non-empty folder without recursive, and leaves it intact", async () => {
    const root = makeVault();
    fs.mkdirSync(path.join(root, "Attachments"));
    fs.writeFileSync(path.join(root, "Attachments", "a.png"), "bytes");

    await expect(removeVaultFolder(root, "Attachments", false)).rejects.toThrow();
    expect(fs.existsSync(path.join(root, "Attachments", "a.png"))).toBe(true);
  });

  it("removes a populated tree with recursive", async () => {
    const root = makeVault();
    fs.mkdirSync(path.join(root, "Attachments", "thread-1"), { recursive: true });
    fs.writeFileSync(path.join(root, "Attachments", "thread-1", "a.png"), "bytes");
    fs.writeFileSync(path.join(root, "Keep.md"), "# keep");

    await removeVaultFolder(root, "Attachments", true);

    expect(fs.existsSync(path.join(root, "Attachments"))).toBe(false);
    expect(fs.existsSync(path.join(root, "Keep.md"))).toBe(true);
  });

  it("does not delete anything outside the vault", async () => {
    const root = makeVault();
    const outside = makeVault();
    fs.writeFileSync(path.join(outside, "precious.md"), "do not delete");
    const escape = path.relative(root, outside);

    await expect(removeVaultFolder(root, escape, true)).rejects.toThrow(/Path escapes vault/);
    expect(fs.existsSync(path.join(outside, "precious.md"))).toBe(true);
  });

  it("does not delete the vault root", async () => {
    const root = makeVault();
    fs.writeFileSync(path.join(root, "Note.md"), "content");

    await expect(removeVaultFolder(root, ".", true)).rejects.toThrow(/vault root/);
    expect(fs.existsSync(path.join(root, "Note.md"))).toBe(true);
  });

  it("refuses a symlink even when it points at a directory", async () => {
    const root = makeVault();
    const outside = makeVault();
    fs.writeFileSync(path.join(outside, "precious.md"), "do not delete");
    fs.symlinkSync(outside, path.join(root, "Link"));

    // `stat` would report a directory here and the tree outside would go with
    // it; `lstat` sees the link itself.
    await expect(removeVaultFolder(root, "Link", true)).rejects.toThrow(/Not a folder/);
    expect(fs.existsSync(path.join(outside, "precious.md"))).toBe(true);
  });

  it("refuses a file", async () => {
    const root = makeVault();
    fs.writeFileSync(path.join(root, "Note.md"), "content");

    await expect(removeVaultFolder(root, "Note.md", true)).rejects.toThrow(/Not a folder/);
    expect(fs.existsSync(path.join(root, "Note.md"))).toBe(true);
  });

  it("rejects for a folder that does not exist", async () => {
    const root = makeVault();
    await expect(removeVaultFolder(root, "Missing", true)).rejects.toThrow();
  });
});
