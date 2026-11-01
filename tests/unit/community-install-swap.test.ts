import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { swapIntoPlace } from "../../src/main/community";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const geodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "geode-swap-"));
  tempDirs.push(geodeDir);
  const destDir = path.join(geodeDir, "plugins", "claude-threads");
  const staging = path.join(geodeDir, "install-abc");
  await fs.mkdir(destDir, { recursive: true });
  await fs.mkdir(staging);
  await fs.writeFile(path.join(destDir, "main.js"), "old");
  await fs.writeFile(path.join(destDir, "data.json"), '{"threads":[1,2,3]}');
  await fs.mkdir(path.join(destDir, "skill-sources"));
  await fs.writeFile(path.join(destDir, "skill-sources", "a.md"), "skill");
  await fs.writeFile(path.join(staging, "main.js"), "new");
  return { geodeDir, destDir, staging };
}

describe("swapIntoPlace", () => {
  it("installs the new release files and carries plugin state across", async () => {
    const { geodeDir, destDir, staging } = await fixture();
    await swapIntoPlace(staging, destDir, geodeDir);
    expect(await fs.readFile(path.join(destDir, "main.js"), "utf8")).toBe("new");
    expect(await fs.readFile(path.join(destDir, "data.json"), "utf8")).toBe('{"threads":[1,2,3]}');
    expect(await fs.readFile(path.join(destDir, "skill-sources", "a.md"), "utf8")).toBe("skill");
    expect((await fs.readdir(geodeDir)).filter((n) => n.startsWith("install-old-"))).toEqual([]);
  });

  it("keeps the existing plugin, state included, when the swap cannot complete", async () => {
    const { geodeDir, destDir, staging } = await fixture();
    // A staging path that is a file cannot receive the carried-over state.
    await fs.rm(staging, { recursive: true });
    await fs.writeFile(staging, "not a directory");
    await expect(swapIntoPlace(staging, destDir, geodeDir)).rejects.toThrow();
    expect(await fs.readFile(path.join(destDir, "main.js"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(destDir, "data.json"), "utf8")).toBe('{"threads":[1,2,3]}');
  });

  it("installs fresh when there is no previous version", async () => {
    const { geodeDir, destDir, staging } = await fixture();
    await fs.rm(destDir, { recursive: true });
    await swapIntoPlace(staging, destDir, geodeDir);
    expect(await fs.readFile(path.join(destDir, "main.js"), "utf8")).toBe("new");
  });
});
