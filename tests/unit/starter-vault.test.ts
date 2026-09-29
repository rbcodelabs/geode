import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyStarterVault } from "../../src/main/starter-vault";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Builds a fixture `<resources>/starter-vault/` tree for the tests below. */
async function writeFixtureStarterVault(resourcesDir: string): Promise<string> {
  const root = path.join(resourcesDir, "starter-vault");
  await fs.mkdir(path.join(root, "Tour"), { recursive: true });
  await fs.mkdir(path.join(root, "Reading"), { recursive: true });
  await fs.writeFile(path.join(root, "Start here.md"), "# Welcome\n");
  await fs.writeFile(path.join(root, "Tour", "Map of this vault.canvas"), "{}");
  await fs.writeFile(path.join(root, "Reading", "Building a Second Brain.md"), "# BASB\n");
  await fs.mkdir(path.join(root, ".geode"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".geode", "app.json"),
    JSON.stringify({ theme: "light", cssTheme: "Ivory" }, null, 2),
  );
  return root;
}

async function listAllFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(root, full));
    }
  }
  await walk(root);
  return out.sort();
}

describe("copyStarterVault", () => {
  it("copies every non-.geode file into the destination, preserving nested subfolders", async () => {
    const resources = await tempDir("geode-resources-");
    const dest = await tempDir("geode-dest-");
    await writeFixtureStarterVault(resources);

    await copyStarterVault(dest, resources);

    const startHere = await fs.readFile(path.join(dest, "Start here.md"), "utf8");
    expect(startHere).toBe("# Welcome\n");
    const canvas = await fs.readFile(path.join(dest, "Tour", "Map of this vault.canvas"), "utf8");
    expect(canvas).toBe("{}");
    const reading = await fs.readFile(path.join(dest, "Reading", "Building a Second Brain.md"), "utf8");
    expect(reading).toBe("# BASB\n");
  });

  it("only copies app.json inside .geode, skipping any other runtime junk", async () => {
    const resources = await tempDir("geode-resources-");
    const dest = await tempDir("geode-dest-");
    const root = await writeFixtureStarterVault(resources);
    // Simulate a maintainer's checkout that has accumulated runtime state from
    // manually opening resources/starter-vault/ as a vault during development.
    await fs.mkdir(path.join(root, ".geode", "metadata-cache"), { recursive: true });
    await fs.writeFile(path.join(root, ".geode", "metadata-cache", "index.json"), "{}");
    await fs.writeFile(path.join(root, ".geode", "workspace.json"), "{}");
    await fs.writeFile(path.join(root, ".geode", "community.json"), "{}");

    await copyStarterVault(dest, resources);

    const geodeFiles = await listAllFiles(path.join(dest, ".geode"));
    expect(geodeFiles).toEqual(["app.json"]);
    const appJson = JSON.parse(await fs.readFile(path.join(dest, ".geode", "app.json"), "utf8"));
    expect(appJson).toEqual({ theme: "light", cssTheme: "Ivory" });
  });

  it("copies files byte-for-byte, including non-UTF8 content", async () => {
    const resources = await tempDir("geode-resources-");
    const dest = await tempDir("geode-dest-");
    const root = path.join(resources, "starter-vault");
    await fs.mkdir(root, { recursive: true });
    const binaryBytes = Buffer.from([0x00, 0xff, 0xd8, 0xff, 0xe0, 0x7f, 0x80, 0x81, 0xfe]);
    await fs.writeFile(path.join(root, "image.bin"), binaryBytes);

    await copyStarterVault(dest, resources);

    const copied = await fs.readFile(path.join(dest, "image.bin"));
    expect(copied.equals(binaryBytes)).toBe(true);
  });

  it("reproduces the full fixture tree with no missing or extra files", async () => {
    const resources = await tempDir("geode-resources-");
    const dest = await tempDir("geode-dest-");
    await writeFixtureStarterVault(resources);

    await copyStarterVault(dest, resources);

    const files = await listAllFiles(dest);
    expect(files).toEqual([
      ".geode/app.json",
      "Reading/Building a Second Brain.md",
      "Start here.md",
      "Tour/Map of this vault.canvas",
    ]);
  });
});
