import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../../src/main/config-file";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

describe("writeJsonAtomic", () => {
  it("replaces the destination via same-directory temp rename", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "geode-config-")); dirs.push(dir);
    const target = path.join(dir, "hotkeys.json");
    await fs.writeFile(target, '{"old":true}');
    await writeJsonAtomic(target, { version: 1 });
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ version: 1 });
    expect((await fs.readdir(dir)).filter(name => name.includes(".tmp-"))).toEqual([]);
  });

  it("preserves the prior file and cleans the temp file when rename fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "geode-config-")); dirs.push(dir);
    const target = path.join(dir, "hotkeys.json");
    await fs.writeFile(target, '{"old":true}');
    const rename = vi.fn(async () => { throw new Error("interrupted"); });
    await expect(writeJsonAtomic(target, { version: 1 }, { rename })).rejects.toThrow("interrupted");
    expect(await fs.readFile(target, "utf8")).toBe('{"old":true}');
    expect((await fs.readdir(dir)).filter(name => name.includes(".tmp-"))).toEqual([]);
  });
});
