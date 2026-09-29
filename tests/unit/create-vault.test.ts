import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVaultFolder } from "../../src/main/create-vault";
import { vaultNameProblem } from "../../src/shared/vault-name";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "geode-create-vault-"));
  dirs.push(dir);
  return dir;
}

describe("vaultNameProblem", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["a/b", "invalid-characters"],
    ["a\\b", "invalid-characters"],
    ["a:b", "invalid-characters"],
    ["a\0b", "invalid-characters"],
    [".", "reserved"],
    ["..", "reserved"],
    ["é".repeat(128), "too-long"],
    ["a".repeat(256), "too-long"],
  ])("rejects %j as %s", (name, problem) => {
    expect(vaultNameProblem(name)).toBe(problem);
  });

  it("accepts ordinary names, including spaces, dots and 255 bytes", () => {
    expect(vaultNameProblem("My vault")).toBeNull();
    expect(vaultNameProblem("notes.v2")).toBeNull();
    expect(vaultNameProblem("a".repeat(255))).toBeNull();
  });
});

describe("createVaultFolder", () => {
  it("creates an empty folder under the parent and returns its path", async () => {
    const parent = await tempDir();
    const created = await createVaultFolder(parent, "  My vault ");
    expect(created).toBe(path.join(parent, "My vault"));
    expect(await fs.readdir(created)).toEqual([]);
  });

  it("refuses invalid names without touching disk", async () => {
    const parent = await tempDir();
    for (const name of ["", "  ", "a/b", "..", ".", "a:b", "x".repeat(300)]) {
      await expect(createVaultFolder(parent, name)).rejects.toThrow();
    }
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("refuses path traversal attempts", async () => {
    const parent = await tempDir();
    await expect(createVaultFolder(parent, "../escape")).rejects.toThrow();
    await expect(createVaultFolder(parent, "..\\escape")).rejects.toThrow();
    expect(await fs.readdir(path.dirname(parent))).not.toContain("escape");
  });

  it("never reuses or overwrites an existing target", async () => {
    const parent = await tempDir();
    await fs.mkdir(path.join(parent, "Taken"));
    await fs.writeFile(path.join(parent, "Taken", "keep.md"), "x");
    await expect(createVaultFolder(parent, "Taken")).rejects.toThrow(/A folder named Taken already exists/);
    expect(await fs.readFile(path.join(parent, "Taken", "keep.md"), "utf8")).toBe("x");
  });

  it("rejects a missing, relative or non-string parent and non-string name", async () => {
    const parent = await tempDir();
    await expect(createVaultFolder(path.join(parent, "nope"), "v")).rejects.toThrow();
    await expect(createVaultFolder("relative/dir", "v")).rejects.toThrow();
    await expect(createVaultFolder(undefined, "v")).rejects.toThrow();
    await expect(createVaultFolder(parent, 5)).rejects.toThrow();
  });
});
