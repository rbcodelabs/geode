import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `SuggestList<T>` is being extracted out of `SuggestModal<T>` (modals.ts) so
 * it can be mounted directly inside a view's `containerEl` (e.g. the New Tab
 * picker) rather than only inside a floating `Modal` dialog. This test
 * exercises the extracted list's own behavior — fuzzy filtering, keyboard
 * navigation, choose/no-match dispatch, and empty-state rendering — in
 * isolation from `Modal` chrome, since that's exactly the surface the
 * extraction must preserve unchanged for its three existing `SuggestModal`
 * subclasses (QuickSwitcherModal, CommandPaletteModal, CanvasFileSuggestModal).
 *
 * vitest.config.mts runs the `node` environment (no jsdom), so DOM calls need
 * a stub — same pattern as workspace-tab-render-batching.test.ts.
 */
class FakeElement {
  private classes = new Set<string>();
  classList = {
    add: (...names: string[]) => { for (const name of names) this.classes.add(name); },
    remove: (...names: string[]) => { for (const name of names) this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
  };
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  value = "";
  placeholder = "";
  type = "";
  focused = false;
  private text = "";
  private html = "";
  private listeners = new Map<string, Array<(e: any) => void>>();

  get className(): string { return [...this.classes].join(" "); }
  set className(value: string) {
    this.classes.clear();
    for (const name of value.split(/\s+/).filter(Boolean)) this.classes.add(name);
  }

  get textContent(): string { return this.text; }
  set textContent(value: string) { this.text = value; }

  get innerHTML(): string { return this.html; }
  set innerHTML(value: string) {
    this.html = value;
    if (value === "") this.children.length = 0;
  }

  addEventListener(type: string, handler: (e: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (e: any) => void): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const i = list.indexOf(handler);
    if (i !== -1) list.splice(i, 1);
  }

  dispatch(type: string, event: any): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  appendChild(kid: FakeElement): FakeElement {
    this.children.push(kid);
    return kid;
  }

  append(...kids: FakeElement[]): void {
    this.children.push(...kids);
  }

  focus(): void { this.focused = true; }
  scrollIntoView(): void {}
}

function fakeKeydown(key: string) {
  return { key, preventDefault: () => {} } as unknown as KeyboardEvent;
}

beforeEach(() => {
  vi.stubGlobal("document", { createElement: () => new FakeElement() });
});

afterEach(() => vi.unstubAllGlobals());

describe("SuggestList", () => {
  async function makeList(items: string[]) {
    const { SuggestList } = await import("../../src/renderer/modals/modals");
    const chosen: Array<{ item: string; evt: unknown }> = [];
    const noMatch: Array<{ query: string; evt: unknown }> = [];
    class TestList extends SuggestList<string> {
      getItems(): string[] { return items; }
      getItemText(item: string): string { return item; }
      onChooseItem(item: string, evt: KeyboardEvent | MouseEvent): void { chosen.push({ item, evt }); }
      onNoMatch(query: string, evt: KeyboardEvent): void { noMatch.push({ query, evt }); }
    }
    const list = new TestList();
    return { list: list as InstanceType<typeof TestList> & { inputEl: FakeElement; resultsEl: FakeElement }, chosen, noMatch };
  }

  it("shows the configured empty-state text when nothing matches", async () => {
    const { list } = await makeList(["Daily Plan", "Roadmap"]);
    list.inputEl.value = "zzz";
    list.inputEl.dispatch("input", {});
    expect((list.resultsEl.children[0] as unknown as FakeElement).textContent).toBe("No results found.");
  });

  it("filters items with fuzzyMatch as the query changes", async () => {
    const { list } = await makeList(["Daily Plan", "Roadmap", "Banana"]);
    list.inputEl.value = "plan";
    list.inputEl.dispatch("input", {});
    expect(list.resultsEl.children).toHaveLength(1);
    expect((list.resultsEl.children[0] as unknown as FakeElement).textContent).toBe("Daily Plan");
  });

  it("moves the selection with ArrowDown/ArrowUp, wrapping at the ends", async () => {
    const { list } = await makeList(["Alpha", "Bravo", "Charlie"]);
    list.inputEl.value = "";
    list.inputEl.dispatch("input", {});
    // Default selection is index 0.
    expect((list.resultsEl.children[0] as unknown as FakeElement).className).toContain("is-selected");

    list.inputEl.dispatch("keydown", fakeKeydown("ArrowDown"));
    expect((list.resultsEl.children[1] as unknown as FakeElement).className).toContain("is-selected");

    list.inputEl.dispatch("keydown", fakeKeydown("ArrowUp"));
    expect((list.resultsEl.children[0] as unknown as FakeElement).className).toContain("is-selected");

    // Wraps from the first item back to the last on ArrowUp.
    list.inputEl.dispatch("keydown", fakeKeydown("ArrowUp"));
    expect((list.resultsEl.children[2] as unknown as FakeElement).className).toContain("is-selected");
  });

  it("calls onChooseItem with the selected item on Enter", async () => {
    const { list, chosen } = await makeList(["Alpha", "Bravo"]);
    list.inputEl.value = "";
    list.inputEl.dispatch("input", {});
    const evt = fakeKeydown("Enter");
    list.inputEl.dispatch("keydown", evt);
    expect(chosen).toEqual([{ item: "Alpha", evt }]);
  });

  it("calls onNoMatch with the raw query on Enter when nothing matches", async () => {
    const { list, noMatch, chosen } = await makeList(["Alpha", "Bravo"]);
    list.inputEl.value = "nope";
    list.inputEl.dispatch("input", {});
    const evt = fakeKeydown("Enter");
    list.inputEl.dispatch("keydown", evt);
    expect(noMatch).toEqual([{ query: "nope", evt }]);
    expect(chosen).toHaveLength(0);
  });

  it("calls onChooseItem when a result is clicked", async () => {
    const { list, chosen } = await makeList(["Alpha", "Bravo"]);
    list.inputEl.value = "";
    list.inputEl.dispatch("input", {});
    const bravoEl = list.resultsEl.children[1] as unknown as FakeElement;
    const clickEvt = { type: "click" };
    bravoEl.dispatch("click", clickEvt);
    expect(chosen).toEqual([{ item: "Bravo", evt: clickEvt }]);
  });

  it("lets a subclass override the result-row and empty-state class names, so an inline mount coexisting with a floating SuggestModal never shares a bare `.prompt-result`/`.prompt-empty` selector", async () => {
    const { SuggestList } = await import("../../src/renderer/modals/modals");
    class CustomClassList extends SuggestList<string> {
      constructor() {
        super();
        this.resultClassName = "custom-result";
        this.emptyClassName = "custom-empty";
      }
      getItems(): string[] { return ["Alpha"]; }
      getItemText(item: string): string { return item; }
      onChooseItem(): void {}
    }
    const list = new CustomClassList() as CustomClassList & { inputEl: FakeElement; resultsEl: FakeElement };

    list.inputEl.value = "Alpha";
    list.inputEl.dispatch("input", {});
    expect((list.resultsEl.children[0] as unknown as FakeElement).className).toContain("custom-result");
    expect((list.resultsEl.children[0] as unknown as FakeElement).className).not.toContain("prompt-result");

    list.inputEl.value = "zzz";
    list.inputEl.dispatch("input", {});
    expect((list.resultsEl.children[0] as unknown as FakeElement).className).toBe("custom-empty");
  });
});
