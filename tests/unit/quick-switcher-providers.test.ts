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
