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

// A plugin whose onload registers a command only AFTER an await — enable()
// must block on the async onload so the registration is visible on return.
function asyncMainJsSource(id: string): string {
  return `
    const { Plugin } = require('geode');
    class AsyncPlugin extends Plugin {
      async onload() {
        await Promise.resolve();
        await Promise.resolve();
        globalThis.__pluginLog.push('${id}:onload');
        this.addCommand({ id: 'late', name: 'Late', callback: () => {} });
      }
    }
    module.exports.default = AsyncPlugin;
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

// A plugin whose async onload() does its synchronous registrations, then
// blocks forever on a promise that never settles (mirrors the real-world
// Claude Threads hang that wedged the installer). enable() must not wait on it
// indefinitely.
function hangingMainJsSource(id: string): string {
  return `
    const { Plugin } = require('geode');
    class HangingPlugin extends Plugin {
      async onload() {
        globalThis.__pluginLog.push('${id}:onload');
        this.addCommand({ id: 'sync', name: 'Sync', callback: () => {} });
        await new Promise(() => {}); // never resolves
        globalThis.__pluginLog.push('${id}:after-hang'); // unreachable
      }
    }
    module.exports.default = HangingPlugin;
  `;
}

// A plugin whose async onload() rejects after an await (a genuine load
// failure, distinct from a hang) — enable() must roll back and throw.
function rejectingAsyncMainJsSource(): string {
  return `
    const { Plugin } = require('geode');
    class RejectingPlugin extends Plugin {
      async onload() {
        await Promise.resolve();
        throw new Error("async boom during onload");
      }
    }
    module.exports.default = RejectingPlugin;
  `;
}

function lateRejectingMainJsSource(): string {
  return `
    const { Plugin } = require('geode');
    module.exports.default = class extends Plugin {
      async onload() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('late onload boom');
      }
    };
  `;
}

function resilientPluginSource(id: string): string {
  return `
    const { Plugin } = require('geode');
    class ResilientPlugin extends Plugin {
      onload() {
        this.addCommand({ id: 'explode', name: 'Explode', callback: () => { throw new Error('command boom'); } });
        this.addCommand({ id: 'reject', name: 'Reject', callback: async () => { throw new Error('async boom'); } });
      }
    }
    module.exports.default = ResilientPlugin;
  `;
}

function boundaryPluginSource(): string {
  return `
    const { Plugin } = require('geode');
    module.exports.default = class extends Plugin {
      onload() {
        this.registerDomEvent(globalThis.__pluginElement, 'click', () => { throw new Error('dom boom'); });
        this.registerView('bad-view', () => ({
          viewType: 'bad-view', containerEl: {}, getDisplayText(){ return 'Bad'; }, getIcon(){ return 'x'; },
          onOpen(){ throw new Error('view boom'); }, onClose(){}
        }));
      }
    };
  `;
}

interface FakeFs {
  files: Map<string, string>;
  config: Map<string, unknown>;
}

function installFakeGeode(
  pluginIds: string[],
  opts: { policy?: unknown } = {}
): FakeFs {
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
    getPluginPolicy: vi.fn(async () => opts.policy ?? null),
    getCrashRecoveryState: vi.fn(async () => ({ suppressPlugins: false, entries: [] })),
    reportCrashDiagnostic: vi.fn(async () => {}),
  };
  (globalThis as any).window = { geode };
  return fs;
}

const fakeApp = {
  commands: { add: vi.fn(), remove: vi.fn() },
  notify: vi.fn(),
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

  it("stamps manifest.dir with the plugin's vault-relative folder at load time (mirrors Obsidian)", async () => {
    const fs = installFakeGeode(["claude-threads"]);
    // manifest.json on disk deliberately has NO `dir` — Obsidian/Geode set it
    // at load time, so a plugin can resolve sibling files against itself.
    fs.files.set(
      ".geode/plugins/claude-threads/manifest.json",
      manifestJson("claude-threads")
    );

    const pm = new PluginManager(fakeApp);
    await pm.initialize();

    // Regression guard for the Claude Threads skill-sources crash: without a
    // populated `dir`, `path.join(vaultRoot, manifest.dir, ...)` throws
    // TypeError (Received undefined) during onload.
    expect(pm.getManifest("claude-threads")?.dir).toBe(".geode/plugins/claude-threads");
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

  it("suppresses all startup plugins while recovering from a renderer crash without mutating the enabled list", async () => {
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/foo/main.js", mainJsSource("foo"));
    fs.config.set("plugins", ["foo"]);
    const geode = (globalThis as any).window.geode;
    geode.getCrashRecoveryState.mockResolvedValue({ suppressPlugins: true, entries: [{ type: "renderer-gone" }] });

    const pm = new PluginManager(fakeApp);
    await pm.initialize();

    expect(pm.isEnabled("foo")).toBe(false);
    expect(fs.config.get("plugins")).toEqual(["foo"]);
    expect(pm.isRecoveryMode()).toBe(true);
  });

  it("attributes a throwing command to its plugin, journals it, and quarantines only that plugin", async () => {
    const app = { commands: { add: vi.fn(), remove: vi.fn() }, notify: vi.fn() } as any;
    const fs = installFakeGeode(["foo", "bar"]);
    for (const id of ["foo", "bar"]) {
      fs.files.set(`.geode/plugins/${id}/manifest.json`, manifestJson(id));
      fs.files.set(`.geode/plugins/${id}/main.js`, resilientPluginSource(id));
    }
    const pm = new PluginManager(app);
    await pm.initialize();
    await pm.enable("foo");
    await pm.enable("bar");
    const fooCommand = app.commands.add.mock.calls.find(([cmd]: any[]) => cmd.id === "foo:explode")[0];

    expect(() => fooCommand.callback()).not.toThrow();
    await vi.waitFor(() => expect(pm.isEnabled("foo")).toBe(false));

    expect(pm.isEnabled("bar")).toBe(true);
    expect(fs.config.get("plugin-quarantine")).toMatchObject({ foo: { boundary: "command:explode", message: "command boom" } });
    expect((globalThis as any).window.geode.reportCrashDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ type: "plugin-error", pluginId: "foo", boundary: "command:explode", message: "command boom" })
    );
  });

  it("contains rejected async command callbacks and lets the user reverse quarantine", async () => {
    const app = { commands: { add: vi.fn(), remove: vi.fn() }, notify: vi.fn() } as any;
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/foo/main.js", resilientPluginSource("foo"));
    const pm = new PluginManager(app);
    await pm.initialize();
    await pm.enable("foo");
    const command = app.commands.add.mock.calls.find(([cmd]: any[]) => cmd.id === "foo:reject")[0];

    await expect(command.callback()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(pm.isEnabled("foo")).toBe(false));
    await pm.restoreQuarantined("foo");

    expect(pm.isEnabled("foo")).toBe(true);
    expect(fs.config.get("plugin-quarantine")).toEqual({});
  });

  it("contains errors at registered DOM and plugin-view lifecycle boundaries", async () => {
    let domCallback: (() => void) | undefined;
    (globalThis as any).__pluginElement = {
      addEventListener: vi.fn((_type: string, cb: () => void) => { domCallback = cb; }),
      removeEventListener: vi.fn(),
    };
    let viewFactory: (() => any) | undefined;
    const app = {
      commands: { add: vi.fn(), remove: vi.fn() }, notify: vi.fn(),
      workspace: {
        registerViewFactory: vi.fn((_type: string, factory: () => any) => { viewFactory = factory; }),
        unregisterViewFactory: vi.fn(),
      },
    } as any;
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/foo/main.js", boundaryPluginSource());
    const pm = new PluginManager(app);
    await pm.initialize();
    await pm.enable("foo");

    expect(() => domCallback!()).not.toThrow();
    await vi.waitFor(() => expect(pm.isEnabled("foo")).toBe(false));
    await pm.restoreQuarantined("foo");
    const view = viewFactory!();
    expect(() => view.onOpen()).not.toThrow();
    await vi.waitFor(() => expect(pm.isEnabled("foo")).toBe(false));

    expect((globalThis as any).window.geode.reportCrashDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "foo", boundary: "view-onOpen:bad-view", message: "view boom" })
    );
    delete (globalThis as any).__pluginElement;
  });

  it("still disables the faulty plugin when durable diagnostic reporting fails", async () => {
    const app = { commands: { add: vi.fn(), remove: vi.fn() }, notify: vi.fn() } as any;
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/foo/main.js", resilientPluginSource("foo"));
    (globalThis as any).window.geode.reportCrashDiagnostic.mockRejectedValue(new Error("disk full"));
    const pm = new PluginManager(app);
    await pm.initialize();
    await pm.enable("foo");
    const command = app.commands.add.mock.calls.find(([cmd]: any[]) => cmd.id === "foo:explode")[0];

    command.callback();

    await vi.waitFor(() => expect(pm.isEnabled("foo")).toBe(false));
    expect(fs.config.get("plugin-quarantine")).toMatchObject({ foo: { message: "command boom" } });
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

  it("enable() awaits an async onload, so post-await registrations are done on return", async () => {
    const fs = installFakeGeode(["foo"]);
    fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
    fs.files.set(".geode/plugins/foo/main.js", asyncMainJsSource("foo"));
    const app = { commands: { add: vi.fn(), remove: vi.fn() } } as any;

    const pm = new PluginManager(app);
    await pm.initialize();
    await pm.enable("foo");

    // The command registered AFTER the awaits inside onload must be present
    // immediately after enable() resolves (regression guard: enable awaits
    // the plugin's async onload before returning).
    expect((globalThis as any).__pluginLog).toEqual(["foo:onload"]);
    expect(app.commands.add).toHaveBeenCalledTimes(1);
    expect(app.commands.add.mock.calls[0][0].id).toBe("foo:late");
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

  describe("onload timeout (a hanging plugin must not wedge enable/startup)", () => {
    it("enable() stops waiting when onload never settles: resolves, keeps the plugin loaded, persists, and records a soft load note", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const app = { commands: { add: vi.fn(), remove: vi.fn() } } as any;
      const fs = installFakeGeode(["foo"]);
      fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
      fs.files.set(".geode/plugins/foo/main.js", hangingMainJsSource("foo"));

      const pm = new PluginManager(app, 20);
      await pm.initialize();

      // enable() must NOT hang forever — it resolves once the timeout elapses.
      await expect(pm.enable("foo")).resolves.toBeUndefined();

      // The plugin is considered enabled: its synchronous registrations (the
      // 'sync' command) ran, and it's persisted so it survives a restart.
      expect(pm.isEnabled("foo")).toBe(true);
      expect(app.commands.add).toHaveBeenCalledTimes(1);
      expect(app.commands.add.mock.calls[0][0].id).toBe("foo:sync");
      expect((globalThis as any).__pluginLog).toEqual(["foo:onload"]); // never got past the hang
      expect(fs.config.get("plugins")).toEqual(["foo"]);

      // The stalled onload is surfaced (not silently swallowed) via getLoadError.
      expect(pm.getLoadError("foo")).toMatch(/did not finish|start/i);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("enable() still rolls back and throws when an async onload REJECTS (a real failure, distinct from a hang)", async () => {
      const fs = installFakeGeode(["foo"]);
      fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
      fs.files.set(".geode/plugins/foo/main.js", rejectingAsyncMainJsSource());

      // Generous timeout so the rejection — not the timer — decides the outcome.
      const pm = new PluginManager(fakeApp, 1000);
      await pm.initialize();

      await expect(pm.enable("foo")).rejects.toThrow(/async boom during onload/);
      expect(pm.isEnabled("foo")).toBe(false);
      expect(pm.getPlugin("foo")).toBeUndefined();
      expect(fs.config.get("plugins")).toBeUndefined(); // never persisted
    });

    it("a fast, well-behaved async onload records no load note", async () => {
      const app = { commands: { add: vi.fn(), remove: vi.fn() } } as any;
      const fs = installFakeGeode(["foo"]);
      fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
      fs.files.set(".geode/plugins/foo/main.js", asyncMainJsSource("foo"));

      const pm = new PluginManager(app, 1000);
      await pm.initialize();
      await pm.enable("foo");

      expect(pm.isEnabled("foo")).toBe(true);
      expect(pm.getLoadError("foo")).toBeUndefined();
    });

    it("initialize()'s startup auto-enable does not hang when a persisted plugin's onload never settles", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fs = installFakeGeode(["foo"]);
      fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
      fs.files.set(".geode/plugins/foo/main.js", hangingMainJsSource("foo"));
      fs.config.set("plugins", ["foo"]);

      const pm = new PluginManager(fakeApp, 20);
      // App boot awaits initialize(); a hanging plugin must not wedge it.
      await expect(pm.initialize()).resolves.not.toThrow();

      expect(pm.isEnabled("foo")).toBe(true);
      expect(pm.getLoadError("foo")).toMatch(/did not finish|start/i);
      warn.mockRestore();
    });

    it("quarantines a plugin whose onload rejects after the startup timeout", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fs = installFakeGeode(["foo"]);
      fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
      fs.files.set(".geode/plugins/foo/main.js", lateRejectingMainJsSource());
      const pm = new PluginManager(fakeApp, 5);
      await pm.initialize();
      await pm.enable("foo");
      expect(pm.isEnabled("foo")).toBe(true);

      await vi.waitFor(() => expect(pm.isEnabled("foo")).toBe(false));

      expect(fs.config.get("plugin-quarantine")).toMatchObject({ foo: { boundary: "onload", message: "late onload boom" } });
      warn.mockRestore();
    });
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

  describe("enterprise-managed plugin policy", () => {
    it("enable() throws for a blocked id and never calls the plugin's onload", async () => {
      const fs = installFakeGeode(["foo"], {
        policy: { policyVersion: 1, plugins: { mode: "blocklist", ids: ["foo"] } },
      });
      fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
      fs.files.set(".geode/plugins/foo/main.js", mainJsSource("foo"));

      const pm = new PluginManager(fakeApp);
      await pm.initialize();
      await expect(pm.enable("foo")).rejects.toThrow(/blocked by administrator policy/);

      expect(pm.isEnabled("foo")).toBe(false);
      expect((globalThis as any).__pluginLog).toEqual([]);
    });

    it("isBlocked() reflects blocklist and allowlist modes", async () => {
      const fs = installFakeGeode(["foo", "bar"], {
        policy: { policyVersion: 1, plugins: { mode: "allowlist", ids: ["foo"] } },
      });
      fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
      fs.files.set(".geode/plugins/bar/manifest.json", manifestJson("bar"));

      const pm = new PluginManager(fakeApp);
      await pm.initialize();

      expect(pm.isBlocked("foo")).toBe(false); // allowlisted
      expect(pm.isBlocked("bar")).toBe(true); // not on the allowlist
    });

    it("initialize()'s auto-enable loop skips a blocked previously-enabled id, records a loadErrors entry, notifies, and does not persist", async () => {
      const notify = vi.fn();
      const app = { commands: { add: vi.fn(), remove: vi.fn() }, notify } as unknown as App;
      const fs = installFakeGeode(["foo"], {
        policy: { policyVersion: 1, plugins: { mode: "blocklist", ids: ["foo"] } },
      });
      fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
      fs.files.set(".geode/plugins/foo/main.js", mainJsSource("foo"));
      fs.config.set("plugins", ["foo"]);

      const pm = new PluginManager(app);
      await pm.initialize();

      expect(pm.isEnabled("foo")).toBe(false);
      expect(pm.getLoadError("foo")).toMatch(/blocked by administrator policy/);
      expect((globalThis as any).__pluginLog).toEqual([]);
      // .geode/plugins.json (the persisted enabled-list) is never mutated by policy.
      const geode = (globalThis as any).window.geode;
      expect(geode.writeConfig).not.toHaveBeenCalled();
      // Surfaced via App.notify(), not silent console.error only.
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toMatch(/disabled by your organization's policy/);
    });

    it("isBlocked() reflects policy changes across two initialize() calls (admin relaxes the policy)", async () => {
      const fs = installFakeGeode(["foo"], {
        policy: { policyVersion: 1, plugins: { mode: "blocklist", ids: ["foo"] } },
      });
      fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
      fs.files.set(".geode/plugins/foo/main.js", mainJsSource("foo"));
      fs.config.set("plugins", ["foo"]);

      const pm = new PluginManager(fakeApp);
      await pm.initialize();
      expect(pm.isBlocked("foo")).toBe(true);
      expect(pm.isEnabled("foo")).toBe(false);

      // Admin relaxes the policy — a fresh getPluginPolicy() response.
      const geode = (globalThis as any).window.geode as { getPluginPolicy: ReturnType<typeof vi.fn> };
      geode.getPluginPolicy.mockResolvedValue(null);

      await pm.initialize();
      expect(pm.isBlocked("foo")).toBe(false);
      // Relaxing the policy resumes the plugin automatically next initialize(),
      // with no user action, because the persisted enabled-list still lists it.
      expect(pm.isEnabled("foo")).toBe(true);
    });

    it("a plugin not mentioned by any policy is unaffected", async () => {
      const fs = installFakeGeode(["foo"], {
        policy: { policyVersion: 1, plugins: { mode: "blocklist", ids: ["someone-else"] } },
      });
      fs.files.set(".geode/plugins/foo/manifest.json", manifestJson("foo"));
      fs.files.set(".geode/plugins/foo/main.js", mainJsSource("foo"));

      const pm = new PluginManager(fakeApp);
      await pm.initialize();
      await expect(pm.enable("foo")).resolves.not.toThrow();
      expect(pm.isEnabled("foo")).toBe(true);
    });
  });
});
