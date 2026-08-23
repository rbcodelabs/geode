import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeVaultFile, birthtimeOf } from "../../src/main/vault-write";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function tmpFile(name = "note.md"): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "geode-vault-write-"));
  roots.push(root);
  return path.join(root, "sub", name);
}

describe("writeVaultFile — DataWriteOptions timestamp semantics", () => {
  it("writes content (creating parent dirs) and reports size when no options are given", async () => {
    const abs = await tmpFile();
    const result = await writeVaultFile(abs, "hello");

    await expect(fsp.readFile(abs, "utf8")).resolves.toBe("hello");
    expect(result.size).toBe(5);
    expect(result.mtime).toBeGreaterThan(0);
    expect(result.ctime).toBeGreaterThan(0);
  });

  it("applies DataWriteOptions.mtime exactly on disk and in the returned stat", async () => {
    const abs = await tmpFile();
    // A fixed instant in the past, chosen so it differs from "now".
    const pinned = Date.UTC(2001, 1, 3, 4, 5, 6); // 2001-02-03T04:05:06Z

    const result = await writeVaultFile(abs, "stamped", { mtime: pinned });

    expect(Math.round(result.mtime)).toBe(pinned);
    const st = await fsp.stat(abs);
    expect(Math.round(st.mtimeMs)).toBe(pinned);
    // atime is pinned alongside mtime so the pair stays coherent.
    expect(Math.round(st.atimeMs)).toBe(pinned);
  });

  it("calls utimes only when mtime is provided", async () => {
    const abs = await tmpFile();
    const utimes = vi.fn(fsp.utimes);
    const deps = { mkdir: fsp.mkdir, writeFile: fsp.writeFile, stat: fsp.stat, utimes };

    await writeVaultFile(abs, "a", undefined, deps);
    expect(utimes).not.toHaveBeenCalled();

    await writeVaultFile(abs, "b", { mtime: 1_000_000 }, deps);
    expect(utimes).toHaveBeenCalledTimes(1);
    expect(utimes.mock.calls[0][0]).toBe(abs);
  });

  it("accepts DataWriteOptions.ctime for API compatibility but does not (cannot) set birthtime independently", async () => {
    const abs = await tmpFile();
    // A ctime in the FUTURE relative to the real write, so any incidental
    // birthtime clamping from an earlier mtime cannot mask the result.
    const futureCtime = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000;

    const result = await writeVaultFile(abs, "x", { ctime: futureCtime });

    // The requested creation time is NOT reflected: Node's fs cannot set a
    // file's birthtime independently, so ctime is accepted but not honored.
    expect(Math.round(result.ctime)).not.toBe(futureCtime);
    const st = await fsp.stat(abs);
    expect(st.birthtimeMs).toBeLessThan(futureCtime);
  });
});

describe("birthtimeOf", () => {
  it("returns birthtime when present and falls back to mtime when birthtime is unavailable (0)", () => {
    expect(birthtimeOf({ birthtimeMs: 10, mtimeMs: 20 } as any)).toBe(10);
    expect(birthtimeOf({ birthtimeMs: 0, mtimeMs: 20 } as any)).toBe(20);
    expect(birthtimeOf(null)).toBe(0);
  });
});
