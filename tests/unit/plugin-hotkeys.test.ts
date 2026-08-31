import { describe, expect, it } from "vitest";
import { CommandRegistry } from "../../src/renderer/commands";
import { Plugin } from "../../src/renderer/plugin";

class ProbePlugin extends Plugin {}
const manifest = { id: "probe", name: "Probe", version: "1.0.0", minAppVersion: "0.1.0", description: "", author: "" };

describe("Plugin structured hotkeys", () => {
  it("preserves multiple defaults through add, unload, and re-register with saved overrides", async () => {
    const saved = { version: 1, overrides: { "probe:run": [{ modifiers: ["Mod"], code: "KeyR" }] } };
    const registry = new CommandRegistry({ read: async () => saved, write: async () => {} });
    await registry.loadHotkeys();
    const app = { commands: registry } as any;
    const plugin = new ProbePlugin(app, manifest);
    const defaults = [{ modifiers: ["Mod"] as const, code: "KeyP" }, { modifiers: ["Alt"] as const, code: "KeyP" }];
    const command = plugin.addCommand({ id: "run", name: "Run", hotkeys: defaults });
    expect(command.hotkeys).toEqual(defaults);
    expect(registry.bindingsFor("probe:run")).toEqual([{ modifiers: ["Mod"], code: "KeyR" }]);
    plugin.unload();
    expect(registry.has("probe:run")).toBe(false);
    new ProbePlugin(app, manifest).addCommand({ id: "run", name: "Run", hotkeys: defaults });
    expect(registry.bindingsFor("probe:run")).toEqual([{ modifiers: ["Mod"], code: "KeyR" }]);
  });
});
