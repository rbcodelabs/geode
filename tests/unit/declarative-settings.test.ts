import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "../../src/renderer/api/obsidian";

class FakeClassList {
  values = new Set<string>();
  add(...names: string[]) { names.forEach((name) => this.values.add(name)); }
  toggle(name: string, force?: boolean) {
    const add = force ?? !this.values.has(name);
    if (add) this.values.add(name); else this.values.delete(name);
    return add;
  }
}

class FakeElement {
  className = "";
  classList = new FakeClassList();
  children: FakeElement[] = [];
  textContent = "";
  value: any = "";
  checked = false;
  disabled = false;
  type = "";
  min = "";
  max = "";
  step = "";
  listeners = new Map<string, Array<(event: any) => void>>();
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  append(...children: FakeElement[]) { this.children.push(...children); }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  replaceChildren(...children: FakeElement[]) { this.children = children; }
  empty() { this.children = []; this.textContent = ""; }
  addEventListener(name: string, cb: (event: any) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
  }
  dispatch(name: string, event: Record<string, unknown> = {}) { for (const cb of this.listeners.get(name) ?? []) cb({ target: this, preventDefault() {}, ...event }); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
}

function installDom() {
  vi.stubGlobal("document", { createElement: () => new FakeElement() });
}

afterEach(() => vi.unstubAllGlobals());

describe("declarative PluginSettingTab", () => {
  it("renders groups, binds toggle/dropdown values, persists, and rebuilds idempotently", async () => {
    installDom();
    const saveData = vi.fn(async () => {});
    const plugin = { settings: { enabled: true, style: "a" }, saveData };
    class Tab extends (obsidian.PluginSettingTab as any) {
      getSettingDefinitions() {
        return [{ type: "group", heading: "Features", items: [
          { name: "Enabled", control: { type: "toggle", key: "enabled" } },
          { name: "Style", control: { type: "dropdown", key: "style", options: { a: "A", b: "B" } } },
        ] }];
      }
    }
    const tab = new Tab({}, plugin);
    tab.display();
    const firstCount = tab.containerEl.children.length;
    tab.display();
    expect(tab.containerEl.children.length).toBe(firstCount);
    expect(firstCount).toBeGreaterThan(0);
    expect(tab.getControlValue("enabled")).toBe(true);
    await tab.setControlValue("style", "b");
    expect(plugin.settings.style).toBe("b");
    expect(saveData).toHaveBeenCalledWith(plugin.settings);
    tab.update();
    expect(tab.containerEl.children.length).toBe(firstCount);

    const all = (root: FakeElement): FakeElement[] => [root, ...root.children.flatMap(all)];
    const elements = all(tab.containerEl);
    const toggle = elements.find((element) => element.className === "checkbox-container")!;
    toggle.dispatch("click");
    await Promise.resolve();
    expect(plugin.settings.enabled).toBe(false);
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.dispatch("keydown", { key: " " });
    await Promise.resolve();
    expect(plugin.settings.enabled).toBe(true);
    const dropdown = elements.find((element) => element.type === "select" || element.className.includes("dropdown"))!;
    expect(dropdown.className).toContain("dropdown");
    dropdown.value = "a";
    dropdown.dispatch("change");
    await Promise.resolve();
    expect(plugin.settings.style).toBe("a");
  });

  it("keeps legacy display overrides and surfaces unsupported declarative types", () => {
    installDom();
    class Legacy extends (obsidian.PluginSettingTab as any) { display() { this.containerEl.textContent = "legacy"; } }
    expect(() => new Legacy({}, {}).display()).not.toThrow();
    class Unsupported extends (obsidian.PluginSettingTab as any) {
      getSettingDefinitions() { return [{ name: "Nope", control: { type: "color", key: "x" } }]; }
    }
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const tab = new Unsupported({}, { settings: {}, saveData: vi.fn() });
    tab.display();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Unsupported declarative setting control type"));
    expect(tab.containerEl.children.length).toBeGreaterThan(0);
  });

  it("surfaces unsupported definition types instead of rendering a partial row", () => {
    installDom();
    class UnsupportedDefinition extends (obsidian.PluginSettingTab as any) {
      getSettingDefinitions() {
        return [{ type: "page", name: "Advanced page", items: [{ name: "Hidden child" }] }];
      }
    }
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const tab = new UnsupportedDefinition({}, { settings: {}, saveData: vi.fn() });

    tab.display();

    expect(error).toHaveBeenCalledWith('Unsupported declarative setting definition type "page"');
    expect(tab.containerEl.children).toHaveLength(1);
    const diagnostic = tab.containerEl.children[0];
    expect(diagnostic.classList.values.has("setting-item-error")).toBe(true);
    const descendants = (root: FakeElement): FakeElement[] => [root, ...root.children.flatMap(descendants)];
    expect(descendants(diagnostic).some((child) => child.textContent.includes('Unsupported declarative setting definition type "page"'))).toBe(true);
  });
});

describe("SliderComponent", () => {
  it("clamps and steps values, formats display, and emits only for user input", () => {
    installDom();
    expect((obsidian as any).SliderComponent).toBeTypeOf("function");
    const slider = new (obsidian as any).SliderComponent(new FakeElement());
    const changed = vi.fn();
    slider.setLimits(0, 10, 2).setDisplayFormat((value: number) => `${value}%`).onChange(changed);
    slider.setValue(11);
    expect(slider.getValue()).toBe(10);
    expect(slider.getValuePretty()).toBe("10%");
    expect(changed).not.toHaveBeenCalled();
    slider.sliderEl.value = "7";
    slider.sliderEl.dispatch("input");
    expect(slider.getValue()).toBe(8);
    expect(changed).toHaveBeenCalledWith(8);
  });
});
