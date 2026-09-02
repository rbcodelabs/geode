import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapFreshVault, type InstallCommunityFn } from "../../src/main/default-vault-bootstrap";

const dirs: string[] = [];
const originalResourcesDir = process.env.GEODE_RESOURCES_DIR;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  if (originalResourcesDir === undefined) {
    delete process.env.GEODE_RESOURCES_DIR;
  } else {
    process.env.GEODE_RESOURCES_DIR = originalResourcesDir;
  }
});

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Points GEODE_RESOURCES_DIR at a fresh temp dir and returns it. */
async function useTempResourcesDir(): Promise<string> {
  const dir = await mkTempDir("geode-resources-");
  process.env.GEODE_RESOURCES_DIR = dir;
  return dir;
}

async function writeDefaultTheme(resourcesDir: string, themeName: string): Promise<void> {
  const themeDir = path.join(resourcesDir, "default-theme", themeName);
  await fs.mkdir(themeDir, { recursive: true });
  await fs.writeFile(path.join(themeDir, "theme.css"), `/* ${themeName} */\nbody.theme-light { --text-normal: #111; }\n`);
  await fs.writeFile(
    path.join(themeDir, "manifest.json"),
    JSON.stringify({ name: themeName, version: "1.0.0", minAppVersion: "0.7.0", author: "Test Org" }, null, 2)
  );
}

async function writeDefaultPlugins(resourcesDir: string, plugins: string[]): Promise<void> {
  await fs.mkdir(resourcesDir, { recursive: true });
  await fs.writeFile(path.join(resourcesDir, "default-plugins.json"), JSON.stringify({ plugins }, null, 2));
}

const neverCalled: InstallCommunityFn = async () => {
  throw new Error("installCommunity should not have been called");
};

describe("bootstrapFreshVault — no-op paths", () => {
  it("does nothing when resources/default-plugins.json and resources/default-theme/ are both absent (the upstream default)", async () => {
    const vaultDir = await mkTempDir("geode-vault-");
    await useTempResourcesDir(); // empty temp dir — neither default-theme/ nor default-plugins.json exists

    await expect(bootstrapFreshVault(vaultDir, { installCommunity: neverCalled })).resolves.toBeUndefined();

    // Not even .geode/ itself should be created — this is a true no-op.
    await expect(fs.stat(path.join(vaultDir, ".geode"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never touches a vault that already has a .geode/ folder, regardless of what's in resources/", async () => {
    const vaultDir = await mkTempDir("geode-vault-");
    const geodeDir = path.join(vaultDir, ".geode");
    await fs.mkdir(geodeDir, { recursive: true });
    await fs.writeFile(path.join(geodeDir, "marker.txt"), "pre-existing vault, do not touch");

    const resourcesDir = await useTempResourcesDir();
    await writeDefaultTheme(resourcesDir, "SomeOrgTheme");
    await writeDefaultPlugins(resourcesDir, ["owner/repo-a"]);

    await bootstrapFreshVault(vaultDir, { installCommunity: neverCalled });

    // The pre-existing marker survives untouched, and none of the seeding
    // artifacts were written.
    expect(await fs.readFile(path.join(geodeDir, "marker.txt"), "utf8")).toBe("pre-existing vault, do not touch");
    await expect(fs.stat(path.join(geodeDir, "themes"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(geodeDir, "plugins.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(geodeDir, "app.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("bootstrapFreshVault — seeding", () => {
  it("copies the default theme, installs every default plugin, and seeds app.json", async () => {
    const vaultDir = await mkTempDir("geode-vault-");
    const resourcesDir = await useTempResourcesDir();
    await writeDefaultTheme(resourcesDir, "MyOrgTheme");
    await writeDefaultPlugins(resourcesDir, ["owner/repo-a", "owner/repo-b"]);

    const calledWith: string[] = [];
    const install: InstallCommunityFn = async (_root, specInput) => {
      calledWith.push(specInput);
      const id = specInput === "owner/repo-a" ? "plugin-a" : "plugin-b";
      return { id };
    };

    await bootstrapFreshVault(vaultDir, { installCommunity: install });

    expect(calledWith.sort()).toEqual(["owner/repo-a", "owner/repo-b"]);

    const geodeDir = path.join(vaultDir, ".geode");
    const themeCss = await fs.readFile(path.join(geodeDir, "themes", "MyOrgTheme", "theme.css"), "utf8");
    expect(themeCss).toContain("MyOrgTheme");
    const themeManifest = JSON.parse(await fs.readFile(path.join(geodeDir, "themes", "MyOrgTheme", "manifest.json"), "utf8"));
    expect(themeManifest.name).toBe("MyOrgTheme");

    const plugins = JSON.parse(await fs.readFile(path.join(geodeDir, "plugins.json"), "utf8"));
    expect(plugins.sort()).toEqual(["plugin-a", "plugin-b"]);

    const appConfig = JSON.parse(await fs.readFile(path.join(geodeDir, "app.json"), "utf8"));
    expect(appConfig).toEqual({ theme: "light", cssTheme: "MyOrgTheme" });
  });

  it("skips a plugin that fails to install, still seeds the ones that succeed, and still resolves (never blocks opening the vault)", async () => {
    const vaultDir = await mkTempDir("geode-vault-");
    const resourcesDir = await useTempResourcesDir();
    await writeDefaultTheme(resourcesDir, "MyOrgTheme");
    await writeDefaultPlugins(resourcesDir, ["owner/good", "owner/bad", "owner/also-good"]);

    const install: InstallCommunityFn = async (_root, specInput) => {
      if (specInput === "owner/bad") {
        throw new Error("simulated network failure");
      }
      return { id: specInput === "owner/good" ? "good-id" : "also-good-id" };
    };

    await expect(bootstrapFreshVault(vaultDir, { installCommunity: install })).resolves.toBeUndefined();

    const geodeDir = path.join(vaultDir, ".geode");
    const plugins = JSON.parse(await fs.readFile(path.join(geodeDir, "plugins.json"), "utf8"));
    expect(plugins.sort()).toEqual(["also-good-id", "good-id"]);

    // The independent theme step still completed despite the plugin failure.
    await expect(fs.stat(path.join(geodeDir, "themes", "MyOrgTheme", "theme.css"))).resolves.toBeDefined();
    const appConfig = JSON.parse(await fs.readFile(path.join(geodeDir, "app.json"), "utf8"));
    expect(appConfig.cssTheme).toBe("MyOrgTheme");
  });

  it("skips plugin seeding entirely when default-plugins.json is absent, even if a default theme is present", async () => {
    const vaultDir = await mkTempDir("geode-vault-");
    const resourcesDir = await useTempResourcesDir();
    await writeDefaultTheme(resourcesDir, "MyOrgTheme");
    // No default-plugins.json written.

    await bootstrapFreshVault(vaultDir, { installCommunity: neverCalled });

    const geodeDir = path.join(vaultDir, ".geode");
    await expect(fs.stat(path.join(geodeDir, "plugins.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(geodeDir, "themes", "MyOrgTheme", "theme.css"))).resolves.toBeDefined();
  });

  it("skips theme seeding entirely when default-theme/ is absent, even if default plugins are present", async () => {
    const vaultDir = await mkTempDir("geode-vault-");
    const resourcesDir = await useTempResourcesDir();
    await writeDefaultPlugins(resourcesDir, ["owner/repo-a"]);
    // No default-theme/ directory written.

    const install: InstallCommunityFn = async () => ({ id: "plugin-a" });
    await bootstrapFreshVault(vaultDir, { installCommunity: install });

    const geodeDir = path.join(vaultDir, ".geode");
    await expect(fs.stat(path.join(geodeDir, "themes"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(geodeDir, "app.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const plugins = JSON.parse(await fs.readFile(path.join(geodeDir, "plugins.json"), "utf8"));
    expect(plugins).toEqual(["plugin-a"]);
  });
});
