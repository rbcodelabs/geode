import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager } from "../../src/renderer/plugin-manager";
import type { App } from "../../src/renderer/app";
import { GEODE_API_VERSION } from "../../src/renderer/plugin-manifest";

/** Minimal manifest.json content, valid unless overridden. */
function manifestJson(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    minAppVersion: "0.1.0",
    description: "A test plugin",
    author: "Test Author",
    ...overrides,
  });
}

/** main.js source for a plugin whose onload/onunload push into a shared log array (accessible via globalThis so the compiled code can reach it). */
function mainJsSource(id: string): string {
  return `
    const { Plugin } = require('geode');
    class TestPlugin extends Plugin {
      onload() {
        globalThis.__pluginLog.push('${id}:onload');
        this.addCommand({ id: 'noop', name: 'Noop', callback: () => {} });
      }
      onunload() {
        globalThis.__pluginLog.push('${id}:onunload');
      }
    }
    module.exports.default = TestPlugin;
  `;
}

function brokenMainJsSource(): string {
  return `module.exports.default = { not: "a class" };`;
}

function throwingMainJsSource(): string {
  return `
    const { Plugin } = require('geode');
    class ThrowingPlugin extends Plugin {
      onload() {
        throw new Error("boom during onload");
      }
    }
    module.exports.default = ThrowingPlugin;
  `;
}

interface FakeFs {
  files: Map<string, string>;
  config: Map<string, unknown>;
}

function installFakeGeode(pluginIds: string[]): FakeFs {
  const fs: FakeFs = { files: new Map(), config: new Map() };
  const geode = {
    listPluginIds: vi.fn(async () => pluginIds),
    read: vi.fn(async (path: string) => {
      const content = fs.files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    }),
    write: vi.fn(async (path: string, data: string) => {
      fs.files.set(path, data);
      return { mtime: 0, size: data.length };
    }),
    readConfig: vi.fn(async (name: string) => fs.config.get(name) ?? null),
    writeConfig: vi.fn(async (name: string, data: unknown) => {
      fs.config.set(name, data);
    }),
  };
  (globalThis as any).window = { geode };
  return fs;
}

const fakeApp = {
  commands: { add: vi.fn(), remove: vi.fn() },
} as unknown as App;

describe("PluginManager", () => {
  beforeEach(() => {
    (globalThis as any).__pluginLog = [];
  });

  afterEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).__pluginLog;
  });

  it("discovers installed plugins and exposes their manifests", async () => {
    const fs = installFakeGeode(["foo", "bar"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/bar/manifest.json", manifestJson("bar"));

    const pm = new PluginManager(fakeApp);
    await pm.initialize();

    const ids = pm.listManifests().map((m) => m.id).sort();
    expect(ids).toEqual(["bar", "foo"]);
    expect(pm.getManifest("foo")?.name).toBe("Plugin foo");
  });

  it("records a load error and skips a plugin whose manifest is invalid, without failing discovery of the rest", async () => {
    const fs = installFakeGeode(["good", "bad"]);
    fs.files.set(".geode/plugins/good/manifest.json", manifestJson("good"));
    fs.files.set(".geode/plugins/bad/manifest.json", "{ not valid json");

    const pm = new PluginManager(fakeApp);
    await pm.initialize();

    expect(pm.listManifests().map((m) => m.id)).toEqual(["good"]);
    expect(pm.getManifest("bad")).toBeUndefined();
    expect(pm.getLoadError("bad")).toMatch(/not valid JSON/);
  });

  it("auto-enables plugins listed in persisted config on initialize, without re-persisting", async () => {
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/foo/main.js", mainJsSource("foo"));
    fs.config.set("plugins", ["foo"]);

    const pm = new PluginManager(fakeApp);
    await pm.initialize();

    expect(pm.isEnabled("foo")).toBe(true);
    expect(pm.getPlugin("foo")).toBeDefined();
    expect((globalThis as any).__pluginLog).toEqual(["foo:onload"]);
    // Re-enabling on startup shouldn't rewrite the config that was just read from.
    const geode = (globalThis as any).window.geode;
    expect(geode.writeConfig).not.toHaveBeenCalled();
  });

  it("ignores config entries for plugins that are no longer installed", async () => {
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/foo/main.js", mainJsSource("foo"));
    fs.config.set("plugins", ["foo", "ghost"]);

    const pm = new PluginManager(fakeApp);
    await expect(pm.initialize()).resolves.not.toThrow();

    expect(pm.isEnabled("foo")).toBe(true);
    expect(pm.isEnabled("ghost")).toBe(false);
  });

  it("enable() loads code, instantiates the plugin, calls onload(), and persists the enabled set", async () => {
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/foo/main.js", mainJsSource("foo"));

    const pm = new PluginManager(fakeApp);
    await pm.initialize();
    await pm.enable("foo");

    expect(pm.isEnabled("foo")).toBe(true);
    expect((globalThis as any).__pluginLog).toEqual(["foo:onload"]);
    expect(fs.config.get("plugins")).toEqual(["foo"]);
  });

  it("enable() is a no-op (and does not re-persist) if the plugin is already enabled", async () => {
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/foo/main.js", mainJsSource("foo"));

    const pm = new PluginManager(fakeApp);
    await pm.initialize();
    await pm.enable("foo");
    const geode = (globalThis as any).window.geode;
    geode.writeConfig.mockClear();

    await pm.enable("foo");
    expect((globalThis as any).__pluginLog).toEqual(["foo:onload"]); // only once
    expect(geode.writeConfig).not.toHaveBeenCalled();
  });

  it("enable() throws for an unknown plugin id and does not touch the filesystem", async () => {
    installFakeGeode([]);
    const pm = new PluginManager(fakeApp);
    await pm.initialize();
    await expect(pm.enable("nope")).rejects.toThrow(/Unknown plugin/);
  });

  it("enable() rejects a plugin that requires a newer Geode than is running", async () => {
    const fs = installFakeGeode(["foo"]);
    fs.files.set(
      ".geode/plugins/foo/manifest.json",
      manifestJson("foo", { minAppVersion: "999.0.0" })
    );
    fs.files.set(".geode/plugins/foo/main.js", mainJsSource("foo"));

    const pm = new PluginManager(fakeApp);
    await pm.initialize();
    await expect(pm.enable("foo")).rejects.toThrow(new RegExp(`Geode 999\\.0\\.0\\+ \\(running ${GEODE_API_VERSION}\\)`));
    expect(pm.isEnabled("foo")).toBe(false);
  });

  it("enable() surfaces an error and does not register the plugin when main.js doesn't export a Plugin class", async () => {
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/foo/main.js", brokenMainJsSource());

    const pm = new PluginManager(fakeApp);
    await pm.initialize();
    await expect(pm.enable("foo")).rejects.toThrow(/must export a class extending Plugin/);
    expect(pm.isEnabled("foo")).toBe(false);
  });

  it("enable() rolls back if the plugin's onload() throws", async () => {
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/foo/main.js", throwingMainJsSource());

    const pm = new PluginManager(fakeApp);
    await pm.initialize();
    await expect(pm.enable("foo")).rejects.toThrow(/boom during onload/);
    expect(pm.isEnabled("foo")).toBe(false);
    expect(pm.getPlugin("foo")).toBeUndefined();
  });

  it("disable() calls onunload(), drops the instance, and persists", async () => {
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/foo/main.js", mainJsSource("foo"));

    const pm = new PluginManager(fakeApp);
    await pm.initialize();
    await pm.enable("foo");
    await pm.disable("foo");

    expect(pm.isEnabled("foo")).toBe(false);
    expect(pm.getPlugin("foo")).toBeUndefined();
    expect((globalThis as any).__pluginLog).toEqual(["foo:onload", "foo:onunload"]);
    expect(fs.config.get("plugins")).toEqual([]);
  });

  it("disable() on a plugin that isn't enabled is a harmless no-op", async () => {
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    const pm = new PluginManager(fakeApp);
    await pm.initialize();
    await expect(pm.disable("foo")).resolves.not.toThrow();
    const geode = (globalThis as any).window.geode as { writeConfig: ReturnType<typeof vi.fn> };
    expect(geode.writeConfig).not.toHaveBeenCalled();
  });
});
