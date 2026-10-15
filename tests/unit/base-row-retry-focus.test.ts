import { afterEach, expect, it, vi } from "vitest";
import { BaseView } from "../../src/renderer/views/base-view";
import { BasesTableView } from "../../src/renderer/views/bases/table-view";

afterEach(() => vi.unstubAllGlobals());
class Element {
  children: Element[] = []; handlers: Record<string, (event?: any) => void> = {}; dataset: Record<string, string> = {};
  textContent = "2"; innerHTML = ""; value = ""; type = ""; className = ""; disabled = false;
  constructor(readonly baseOwner: object) {}
  setAttribute() {} replaceChildren() { this.children = []; } appendChild(child: Element) { this.children.push(child); }
  addEventListener(name: string, handler: (event?: any) => void) { this.handlers[name] = handler; }
  closest(selector: string): any { if (selector === ".base-view") return this.baseOwner; return selector.includes("base-row-retry") && this.dataset.baseRowRetry !== undefined ? this : null; }
  focus() {} select() {}
}
function fixture() {
  const baseOwner = {}; const make = () => new Element(baseOwner);
  vi.stubGlobal("document", { createElement: make, body: { classList: { contains: () => false } } });
  const view = Object.create(BaseView.prototype) as any;
  Object.assign(view, { saveStatusEl: make(), sourceEdit: { file: { path: "Note.md" }, columnPath: "note.priority", rawText: "9" }, editCell: vi.fn(async () => {}), tableView: { acknowledgeEdit: vi.fn() }, app: { notify: vi.fn(), vault: { read: async () => "---\npriority: 2\n---\n", modify: async () => { throw new Error("disk rejected"); } } } });
  return { view, make, baseOwner };
}
it("keeps mouse Retry focus from triggering an ordinary blur submission and retries the latest matching draft", async () => {
  const { view } = fixture();
  await expect(view.commitCellEdit({ path: "Note.md" }, "note.priority", "9", { check() {} })).rejects.toThrow("disk rejected");
  const button = view.saveStatusEl.children.find((el: Element) => el.textContent === "Retry Base save");
  expect(button.handlers.pointerdown).toBeTypeOf("function");
  const preventDefault = vi.fn(); button.handlers.pointerdown({ preventDefault }); expect(preventDefault).toHaveBeenCalledOnce();
  view.sourceEdit.rawText = "10"; button.handlers.click(); await new Promise(resolve => setImmediate(resolve));
  expect(view.editCell).toHaveBeenCalledWith(expect.objectContaining({ path: "Note.md" }), "note.priority", "10", true);
  expect(view.tableView.acknowledgeEdit).toHaveBeenCalledOnce();
});
it("preserves a row draft when keyboard focus moves to its exact Base-owned Retry control", () => {
  const { view, make } = fixture(); const table = Object.create(BasesTableView.prototype) as any;
  const cell = make(); const onEditCell = vi.fn(async () => {});
  Object.assign(table, { columns: ["note.priority"], dataRows: [{ file: { path: "Note.md" } }], cellEls: [[cell]], containerEl: make(), callbacks: { onEditStart() {}, onEditDraft() {}, onEditEnd() {}, onEditCell } });
  table.startEdit({ row: 0, col: 0 });
  const input = cell.children[0];
  view.setSaveStatus("Base save failed", true, async () => {}, { file: { path: "Note.md" }, columnPath: "note.priority" });
  const button = view.saveStatusEl.children.find((el: Element) => el.textContent === "Retry Base save");
  input.handlers.blur({ relatedTarget: button });
  expect(onEditCell).not.toHaveBeenCalled();
  const unrelated = new Element({}); unrelated.dataset.baseRowRetry = JSON.stringify(["Note.md", "note.priority"]);
  input.handlers.blur({ relatedTarget: unrelated }); expect(onEditCell).toHaveBeenCalledOnce();
});

it("refuses a stale row Retry while another file or column owns the current draft", async () => {
  const { view } = fixture();
  view.sourceEdit = { file: { path: "Other.md" }, columnPath: "note.priority", rawText: "10" };
  await view.retryRowEdit({ path: "Note.md" }, "note.priority", "9");
  expect(view.editCell).not.toHaveBeenCalled(); expect(view.tableView.acknowledgeEdit).not.toHaveBeenCalled();
  expect(view.sourceEdit.rawText).toBe("10"); expect(view.app.notify).toHaveBeenCalledWith(expect.stringMatching(/current cell draft/));
});
