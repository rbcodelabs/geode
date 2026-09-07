import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import { Events } from "../../src/renderer/events";

function installDom(order: string[] = []) {
  const classes = new Set<string>();
  vi.stubGlobal("document", {
    body: {
      classList: {
        contains: (name: string) => classes.has(name),
        add: (...names: string[]) => names.forEach((name) => classes.add(name)),
        toggle: (name: string, force: boolean) => force ? classes.add(name) : classes.delete(name),
      },
      style: { setProperty: (name: string, value: string) => order.push(`apply:${name}:${value}`) },
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  vi.stubGlobal("getComputedStyle", () => ({ backgroundColor: "rgb(0, 0, 0)" }));
}

function makeApp(order: string[] = [], writeImpl?: () => Promise<void>) {
  installDom(order);
  const write = vi.fn(async (key: string) => {
    order.push(`persist:${key}`);
    await writeImpl?.();
  });
  const host = {
    config: { read: vi.fn(), write },
    capabilities: { multipleWindows: false },
  } as any;
  const app = new App(host);
  app.workspace = new Events() as any;
  return { app, write };
}

afterEach(() => vi.unstubAllGlobals());

describe("Obsidian app config compatibility", () => {
  it("defaults and validates the supported persisted fields", () => {
    const { app } = makeApp();
    expect(app.settings.baseFontSize).toBe(16);
    expect(app.settings.foldHeading).toBe(false);
    expect(app.settings.showLineNumber).toBe(false);
  });

  it("maps theme names and performs mutate/apply/persist/events once", async () => {
    const order: string[] = [];
    const { app, write } = makeApp(order);
    app.vault.on("config-changed", () => order.push("event:config-changed"));
    app.workspace.on("css-change", () => order.push("event:css-change"));

    expect(app.vault.getConfig("theme")).toBe("obsidian");
    await (app.vault as any).setConfig("baseFontSize", 18);
    expect(app.settings.baseFontSize).toBe(18);
    expect(order).toEqual([
      "apply:--font-text-size:18px",
      "persist:app",
      "event:config-changed",
      "event:css-change",
    ]);
    await (app.vault as any).setConfig("baseFontSize", 18);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("no-ops unknown keys and invalid values", async () => {
    const { app, write } = makeApp();
    await (app.vault as any).setConfig("not-real", true);
    await (app.vault as any).setConfig("baseFontSize", -1);
    expect(app.vault.getConfig("not-real")).toBeUndefined();
    expect(app.settings.baseFontSize).toBe(16);
    expect(write).not.toHaveBeenCalled();
  });

  it("round-trips every allowlisted config key and rejects invalid shapes", async () => {
    const { app, write } = makeApp();
    for (const [key, value, expected] of [
      ["foldHeading", true, true],
      ["showLineNumber", true, true],
      ["readableLineLength", false, false],
      ["theme", "moonstone", "moonstone"],
    ] as const) {
      await (app.vault as any).setConfig(key, value);
      expect(app.vault.getConfig(key)).toBe(expected);
    }
    const writes = write.mock.calls.length;
    await (app.vault as any).setConfig("foldHeading", "yes");
    await (app.vault as any).setConfig("theme", "system");
    await (app.vault as any).setConfig("showLineNumber", true);
    expect(write).toHaveBeenCalledTimes(writes);
  });

  it("rolls back a failed persist and permits a same-value retry without unhandled rejection", async () => {
    let fail = true;
    const order: string[] = [];
    const { app, write } = makeApp(order, async () => {
      if (fail) { fail = false; throw new Error("disk full"); }
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await (app.vault as any).setConfig("baseFontSize", 18);
    expect(app.settings.baseFontSize).toBe(16);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("baseFontSize"), expect.any(Error));
    await (app.vault as any).setConfig("baseFontSize", 18);
    expect(app.settings.baseFontSize).toBe(18);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
