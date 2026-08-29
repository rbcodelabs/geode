import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeVaultFile, validateMtime, type VaultWriteDeps } from "../../src/main/vault-write";
import { birthtimeOf } from "../../src/main/fs-utils";

const temporaryRoots: string[] = [];

function makeVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-write-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("writeVaultFile", () => {
  it("writes with no options and returns sane real metadata", async () => {
    const root = makeVault();
    const target = path.join(root, "Note.md");

    const result = await writeVaultFile(target, "hello");

    expect(result.size).toBe("hello".length);
    expect(result.mtime).toBeGreaterThan(0);
    expect(result.ctime).toBeGreaterThan(0);
    await expect(fsp.readFile(target, "utf8")).resolves.toBe("hello");
  });

  it("applies a provided mtime exactly on disk", async () => {
    const root = makeVault();
    const target = path.join(root, "Note.md");
    // Truncate to whole seconds since fs.utimes only has second resolution.
    const pinnedMs = Math.floor(new Date("2020-01-02T03:04:05Z").getTime() / 1000) * 1000;

    const result = await writeVaultFile(target, "hello", { mtime: pinnedMs });

    expect(result.mtime).toBe(pinnedMs);
    const st = await fsp.stat(target);
    expect(st.mtimeMs).toBe(pinnedMs);
  });

  it("accepts ctime but does not apply it to the file's real birthtime", async () => {
    const root = makeVault();
    const target = path.join(root, "Note.md");
    const requestedCtimeMs = new Date("1999-01-01T00:00:00Z").getTime();

    await writeVaultFile(target, "hello", { ctime: requestedCtimeMs });

    const st = await fsp.stat(target);
    // birthtime (if the filesystem tracks it) reflects real creation time,
    // never the caller-requested value — fs.utimes cannot set it.
    expect(birthtimeOf(st)).not.toBe(requestedCtimeMs);
  });

  it("only calls utimes when mtime is provided", async () => {
    const root = makeVault();
    const withMtime = path.join(root, "WithMtime.md");
    const withoutMtime = path.join(root, "WithoutMtime.md");
    const utimes = vi.fn(async () => {});
    const deps: VaultWriteDeps = {
      mkdir: fsp.mkdir,
      writeFile: fsp.writeFile,
      utimes,
      stat: fsp.stat,
    };

    await writeVaultFile(withMtime, "hello", { mtime: 1_600_000_000_000 }, deps);
    expect(utimes).toHaveBeenCalledTimes(1);

    await writeVaultFile(withoutMtime, "hello", undefined, deps);
    expect(utimes).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid mtime and never creates the target file", async () => {
    const root = makeVault();
    const target = path.join(root, "Note.md");

    await expect(writeVaultFile(target, "hello", { mtime: NaN })).rejects.toThrow(
      /invalid.*mtime/i,
    );

    await expect(fsp.access(target)).rejects.toThrow();
    await expect(fsp.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-finite mtime (Infinity) before touching disk", async () => {
    const root = makeVault();
    const target = path.join(root, "Note.md");

    await expect(writeVaultFile(target, "hello", { mtime: Infinity })).rejects.toThrow();
    await expect(fsp.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never calls mkdir/writeFile when mtime validation fails", async () => {
    const root = makeVault();
    const target = path.join(root, "Nested", "Note.md");
    const mkdir = vi.fn(fsp.mkdir);
    const writeFile = vi.fn(fsp.writeFile);
    const deps: VaultWriteDeps = {
      mkdir,
      writeFile,
      utimes: fsp.utimes,
      stat: fsp.stat,
    };

    await expect(writeVaultFile(target, "hello", { mtime: NaN }, deps)).rejects.toThrow();

    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe("validateMtime", () => {
  it("returns undefined for an omitted mtime", () => {
    expect(validateMtime(undefined)).toBeUndefined();
  });

  it("converts a valid ms-since-epoch value to seconds", () => {
    expect(validateMtime(1_600_000_000_000)).toBe(1_600_000_000);
  });

  it("throws for NaN, Infinity, and non-number values", () => {
    expect(() => validateMtime(NaN)).toThrow();
    expect(() => validateMtime(Infinity)).toThrow();
    expect(() => validateMtime(-Infinity)).toThrow();
    expect(() => validateMtime("not a number" as unknown as number)).toThrow();
  });
});

describe("birthtimeOf", () => {
  it("returns birthtimeMs when the filesystem reports a positive value", () => {
    const st = { birthtimeMs: 100, mtimeMs: 200 } as fs.Stats;
    expect(birthtimeOf(st)).toBe(100);
  });

  it("falls back to mtimeMs when birthtimeMs is zero (unavailable)", () => {
    const st = { birthtimeMs: 0, mtimeMs: 200 } as fs.Stats;
    expect(birthtimeOf(st)).toBe(200);
  });

  it("returns 0 for a null stat", () => {
    expect(birthtimeOf(null)).toBe(0);
  });
});
