import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listThemes, readThemeCss } from "../../src/main/builtin-themes";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function writeTheme(root: string, name: string, css: string): Promise<void> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "theme.css"), css);
}

describe("built-in desktop themes", () => {
  it("ships Ivory through electron-builder's packaged resources", async () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    const css = await fs.readFile(
      path.join(repoRoot, "resources", "builtin-themes", "Ivory", "theme.css"),
      "utf8",
    );
    const manifest = JSON.parse(await fs.readFile(
      path.join(repoRoot, "resources", "builtin-themes", "Ivory", "manifest.json"),
      "utf8",
    ));

    expect(packageJson.build.files).toContain("resources/**/*");
    expect(manifest.name).toBe("Ivory");
    expect(css).toContain("--interactive-accent");
  });

  it("lists a built-in theme for a pre-existing vault with no themes directory", async () => {
    const vault = await tempDir("geode-existing-vault-");
    const resources = await tempDir("geode-resources-");
    await fs.mkdir(path.join(vault, ".geode"));
    await writeTheme(path.join(resources, "builtin-themes"), "Ivory", "/* bundled */");

    await expect(listThemes(vault, resources)).resolves.toEqual(["Ivory"]);
  });

  it("returns the sorted, deduplicated union while retaining local-only themes", async () => {
    const vault = await tempDir("geode-vault-");
    const resources = await tempDir("geode-resources-");
    await writeTheme(path.join(resources, "builtin-themes"), "Ivory", "/* bundled */");
    await writeTheme(path.join(resources, "builtin-themes"), "Amber", "/* bundled */");
    await writeTheme(path.join(vault, ".geode", "themes"), "Ivory", "/* local override */");
    await writeTheme(path.join(vault, ".geode", "themes"), "Zen", "/* local only */");

    await expect(listThemes(vault, resources)).resolves.toEqual(["Amber", "Ivory", "Zen"]);
  });

  it("reads a same-name local override before the bundled theme", async () => {
    const vault = await tempDir("geode-vault-");
    const resources = await tempDir("geode-resources-");
    await writeTheme(path.join(resources, "builtin-themes"), "Ivory", "/* bundled */");
    await writeTheme(path.join(vault, ".geode", "themes"), "Ivory", "/* local override */");

    await expect(readThemeCss(vault, "Ivory", resources)).resolves.toBe("/* local override */");
  });

  it("falls back to the bundled theme when the local copy vanishes", async () => {
    const vault = await tempDir("geode-vault-");
    const resources = await tempDir("geode-resources-");
    const localDir = path.join(vault, ".geode", "themes", "Ivory");
    await writeTheme(path.join(resources, "builtin-themes"), "Ivory", "/* bundled */");
    await writeTheme(path.join(vault, ".geode", "themes"), "Ivory", "/* local override */");
    await fs.rm(localDir, { recursive: true });

    await expect(readThemeCss(vault, "Ivory", resources)).resolves.toBe("/* bundled */");
  });

  it.each(["", ".", "..", "../Ivory", "Ivory/../../secret", "Ivory\\..\\secret", "Ivory\0secret"])(
    "rejects invalid theme id %j",
    async (id) => {
      const vault = await tempDir("geode-vault-");
      const resources = await tempDir("geode-resources-");
      await expect(readThemeCss(vault, id, resources)).rejects.toThrow("Invalid theme id");
    },
  );
});
