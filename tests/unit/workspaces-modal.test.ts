import { afterEach, expect, it, vi } from "vitest";
import { WorkspacesModal } from "../../src/renderer/workspaces/workspaces-modal";
import type { NamedWorkspaces } from "../../src/renderer/workspaces/named-workspaces";
class Element {
  className = ""; textContent = ""; disabled = false; value = ""; children: Element[] = [];
  attrs: Record<string, string> = {}; events = new Map<string, () => void>();
  classList = { add: () => {}, toggle: () => {} };
  constructor(readonly tag: string) {}
  append(...elements: Element[]) { this.children.push(...elements); }
  appendChild(element: Element) { this.children.push(element); return element; }
  replaceChildren(...elements: Element[]) { this.children = elements; this.textContent = ""; }
  addEventListener(event: string, callback: () => void) { this.events.set(event, callback); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  querySelectorAll(tag: string) { return this.all().filter(child => child.tag === tag); }
  focus() {} remove() {}
}
const tick = () => new Promise(resolve => setImmediate(resolve));
afterEach(() => vi.unstubAllGlobals());
function setup() {
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag) });
  const records: any[] = [];
  const store = { list: vi.fn(async () => records), get: vi.fn(async () => records[0]), save: vi.fn(async (name: string) => { const record = { id: "one", name }; records.push(record); return record; }), remove: vi.fn(async () => {}) };
  const actions = { capture: () => ({}), load: vi.fn(async () => "Loaded."), run: async <T>(operation: () => Promise<T>) => operation() };
  const modal = new WorkspacesModal({} as never, store as unknown as NamedWorkspaces, actions);
  const elements = () => (modal.contentEl as unknown as Element).all();
  const save = () => elements().find(element => element.tag === "button" && element.textContent === "Save")!;
  const input = () => elements().find(element => element.attrs["aria-label"] === "Name")!;
  return { modal, store, actions, save, input, elements };
}
it("disables saving unreadable layouts and displays the storage error", async () => {
  const { modal, store, save, elements } = setup(); store.list.mockRejectedValue(new Error("unreadable"));
  modal.onOpen(); await tick(); expect(save().disabled).toBe(true);
  expect(elements().find(element => element.attrs.role === "alert")?.textContent).toBe("unreadable");
  save().events.get("click")!(); await tick(); expect(store.save).not.toHaveBeenCalled();
});
it("preserves the entered name after a failed write and permits an explicit retry", async () => {
  const { modal, store, save, input, elements } = setup(); modal.onOpen(); await tick(); input().value = "Writing";
  store.save.mockRejectedValueOnce(new Error("disk full")); save().events.get("click")!(); await tick();
  expect(input().value).toBe("Writing"); expect(save().disabled).toBe(false);
  expect(elements().find(element => element.attrs.role === "alert")?.textContent).toBe("disk full");
  save().events.get("click")!(); await tick(); expect(store.save).toHaveBeenCalledTimes(2);
  expect(elements().some(element => element.textContent === "Writing")).toBe(true);
});
it("blocks repeated actions during an in-flight write and rejects callbacks after close", async () => {
  const { modal, store, save } = setup(); modal.onOpen(); await tick(); let finish!: (value: any) => void;
  store.save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const button = save(); button.events.get("click")!(); button.events.get("click")!(); await tick();
  expect(button.disabled).toBe(true); expect(store.save).toHaveBeenCalledOnce(); modal.onClose(); finish({ id: "one", name: "Writing" }); await tick();
  button.events.get("click")!(); await tick(); expect(store.save).toHaveBeenCalledOnce();
});
