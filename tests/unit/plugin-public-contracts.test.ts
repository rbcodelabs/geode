import { afterEach, describe, expect, it, vi } from "vitest";
import { instantiatePluginClass } from "../../src/renderer/plugin-manager";
import { Plugin } from "../../src/renderer/api/obsidian";

const manifest = {
  id: "contract-probe",
  name: "Contract Probe",
  version: "1.0.0",
  minAppVersion: "1.0.0",
  description: "probe",
  author: "Geode",
  dir: ".custom/plugins/contract-probe",
};

function installWindow(files: Map<string, string>): void {
  vi.stubGlobal("window", {
    geode: {
      read: vi.fn(async (path: string) => {
        if (!files.has(path)) throw new Error("ENOENT");
        return files.get(path)!;
      }),
      write: vi.fn(async (path: string, data: string) => void files.set(path, data)),
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Plugin public foundation", () => {
  it("retains the constructor app and manifest and exposes assignable settings", () => {
    const app = {} as any;
    class Probe extends Plugin {}
    const plugin = new Probe(app, manifest);

    plugin.settings = { enabled: true };
    expect(plugin.app).toBe(app);
    expect(plugin.manifest).toBe(manifest);
    expect(plugin.settings).toEqual({ enabled: true });
  });

  it("loads null before data exists and round-trips data.json in the plugin folder", async () => {
    const files = new Map<string, string>();
    installWindow(files);
    class Probe extends Plugin {}
    const plugin = new Probe({} as any, manifest);

    await expect(plugin.loadData()).resolves.toBeNull();
    await plugin.saveData({ enabled: true, count: 2 });
    expect(JSON.parse(files.get(".custom/plugins/contract-probe/data.json")!)).toEqual({ enabled: true, count: 2 });
    await expect(plugin.loadData()).resolves.toEqual({ enabled: true, count: 2 });
  });

  it("inherits lifecycle registrations and cleans them up on unload", () => {
    installWindow(new Map());
    const log: string[] = [];
    const events = { offref: vi.fn() };
    class Probe extends Plugin {
      override onload(): void {
        log.push("load");
        this.register(() => log.push("cleanup"));
        this.registerEvent((() => events.offref()) as any);
      }
      override onunload(): void {
        log.push("unload");
      }
    }
    const plugin = new Probe({} as any, manifest);

    plugin.load();
    plugin.unload();
    plugin.unload();
    expect(log).toEqual(["load", "cleanup", "unload"]);
    expect(events.offref).toHaveBeenCalledOnce();
  });
});

describe("Plugin through require('obsidian')", () => {
  it("exposes constructor data and inherited registration contracts to CommonJS plugins", async () => {
    const files = new Map<string, string>();
    installWindow(files);
    const PluginClass = instantiatePluginClass(
      `
        const { Events, Plugin } = require("obsidian");
        module.exports = class PluginProbe extends Plugin {
          async onload() {
            this.settings = (await this.loadData()) ?? { starts: 0 };
            this.settings.starts += 1;
            await this.saveData(this.settings);
            const events = new Events();
            this.registerEvent(events.on("ping", () => this.settings.starts += 1));
            this.register(() => this.settings.cleaned = true);
            events.trigger("ping");
          }
          onunload() { this.settings.unloaded = true; }
        };
      `,
      "contract-probe",
    );
    const app = {} as any;
    const plugin = new PluginClass(app, manifest);

    plugin.load();
    await plugin.onloadResult;
    expect(plugin.app).toBe(app);
    expect(plugin.manifest).toBe(manifest);
    expect((plugin as any).settings).toEqual({ starts: 2 });
    plugin.unload();
    expect((plugin as any).settings).toEqual({ starts: 2, cleaned: true, unloaded: true });
  });
});
