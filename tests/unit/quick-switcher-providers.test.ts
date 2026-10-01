import { describe, expect, it, vi } from "vitest";
import { collectQuickSwitcherItems, type QuickSwitcherProvider } from "../../src/renderer/quick-switcher-providers";

const item = (title: string) => ({ title, onChoose: () => {} });

describe("collectQuickSwitcherItems", () => {
  it("returns nothing for an empty query without calling providers", () => {
    const getItems = vi.fn(() => [item("x")]);
    expect(collectQuickSwitcherItems([{ getItems }], "")).toEqual([]);
    expect(getItems).not.toHaveBeenCalled();
  });

  it("concatenates rows from providers in registration order, passing the query", () => {
    const a: QuickSwitcherProvider = { getItems: (q) => [item(`a:${q}`)] };
    const b: QuickSwitcherProvider = { getItems: (q) => [item(`b:${q}`)] };
    expect(collectQuickSwitcherItems(new Set([a, b]), "hi").map((i) => i.title)).toEqual(["a:hi", "b:hi"]);
  });

  it("skips a throwing provider and malformed rows", () => {
    const bad: QuickSwitcherProvider = { getItems: () => { throw new Error("boom"); } };
    const notArray = { getItems: () => "nope" } as unknown as QuickSwitcherProvider;
    const malformed = { getItems: () => [{ title: 3 }, { title: "no handler" }, item("ok")] } as unknown as QuickSwitcherProvider;
    expect(collectQuickSwitcherItems([bad, notArray, malformed], "q").map((i) => i.title)).toEqual(["ok"]);
  });
});

describe("Plugin.registerQuickSwitcherProvider", () => {
  it("skips a throwing provider without reporting to the error boundary, and sibling providers still yield rows", async () => {
    const { Plugin } = await import("../../src/renderer/plugin");
    const registered = new Set<QuickSwitcherProvider>();
    const app = {
      registerQuickSwitcherProvider: (p: QuickSwitcherProvider) => { registered.add(p); return () => registered.delete(p); },
    };
    class TestPlugin extends Plugin { onload() {} }
    const plugin = new TestPlugin(app as never, { id: "qa-test", name: "QA", version: "1", minAppVersion: "0" } as never);
    const errorHandler = vi.fn();
    plugin.setErrorHandler(errorHandler);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    plugin.registerQuickSwitcherProvider({ id: "boom", getItems: () => { throw new Error("boom"); } });
    plugin.registerQuickSwitcherProvider({ id: "ok", getItems: (q) => [item(`ok:${q}`)] });

    expect(collectQuickSwitcherItems(registered, "q").map((i) => i.title)).toEqual(["ok:q"]);
    expect(errorHandler).not.toHaveBeenCalled(); // would quarantine the whole plugin
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
