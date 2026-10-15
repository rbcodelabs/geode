import { afterEach, expect, it, vi } from "vitest";
import { BasesTableView } from "../../src/renderer/views/bases/table-view";
afterEach(() => vi.unstubAllGlobals());
function element(): any { return { children: [] as any[], handlers: {} as Record<string, (event?: any) => void>, dataset: {}, textContent: "2", classList: { contains: () => false }, focus: vi.fn(), select() {}, addEventListener(name: string, callback: (event?: any) => void) { this.handlers[name] = callback; }, appendChild(child: any) { this.children.push(child); } }; }
function fixture() {
  vi.stubGlobal("document", { createElement: element, body: element() });
  const table = Object.create(BasesTableView.prototype) as any;
  const a = element(); const b = element(); const onEditEnd = vi.fn();
  const callbacks = { onEditStart: vi.fn(() => ({})), onEditDraft: vi.fn(), onEditEnd, onEditCell: vi.fn(async () => {}) };
  Object.assign(table, { containerEl: element(), columns: ["note.priority"], dataRows: [{ file: { path: "A.md" } }, { file: { path: "B.md" } }], cellEls: [[a], [b]], callbacks });
  return { table, a, b, callbacks, onEditEnd };
}
const event = (key: string) => ({ key, preventDefault() {}, stopPropagation() {} });
it.each(["success", "failure"])("does not let an older %s completion end or refocus a newer table editor", async outcome => {
  const { table, a, b, callbacks, onEditEnd } = fixture(); let finish!: () => void;
  callbacks.onEditCell.mockImplementation(() => new Promise<void>((resolve, reject) => { finish = () => outcome === "success" ? resolve() : reject(new Error("old row failed")); }));
  table.startEdit({ row: 0, col: 0 }); const inputA = a.children[0]; inputA.value = "9"; inputA.handlers.keydown(event("Enter"));
  const newer = { row: 1, col: 0 }; table.startEdit(newer); const inputB = b.children[0]; inputB.value = "10";
  finish(); await new Promise(resolve => setImmediate(resolve));
  expect(table.editing).toBe(newer); expect(inputB.value).toBe("10"); expect(onEditEnd).not.toHaveBeenCalled();
  expect(inputA.focus).toHaveBeenCalledOnce(); expect(inputB.focus).toHaveBeenCalledOnce();
});
it("ignores an old editor's cancel and an old explicit acknowledgment after a newer session starts", () => {
  const { table, a, onEditEnd } = fixture(); const older = { row: 0, col: 0 }; table.startEdit(older);
  const inputA = a.children[0]; const newer = { row: 1, col: 0 }; table.startEdit(newer);
  inputA.handlers.keydown(event("Escape")); expect(table.editing).toBe(newer); expect(onEditEnd).not.toHaveBeenCalled();
  table.acknowledgeEdit(older); expect(table.editing).toBe(newer); expect(onEditEnd).not.toHaveBeenCalled();
});

it("keeps a reopened session of the same cell independent from old input callbacks", async () => {
  const { table, a, callbacks, onEditEnd } = fixture(); let finish!: () => void;
  callbacks.onEditCell.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const position = { row: 0, col: 0 }; table.startEdit(position); const old = a.children[0];
  old.handlers.keydown(event("Enter")); table.startEdit(position); const current = table.editIdentity;
  old.handlers.input(); old.handlers.keydown(event("Escape")); finish(); await new Promise(resolve => setImmediate(resolve));
  expect(table.editIdentity).toBe(current); expect(callbacks.onEditDraft).not.toHaveBeenCalled(); expect(onEditEnd).not.toHaveBeenCalled();
});
it("finishes old mobile controls before an acknowledgment callback opens another editor", () => {
  const { table, onEditEnd } = fixture(); table.startEdit({ row: 0, col: 0 });
  const old = { remove: vi.fn() }; const newer = { remove: vi.fn() }; table.mobileEditorActionsEl = old;
  onEditEnd.mockImplementation(() => { table.startEdit({ row: 1, col: 0 }); table.mobileEditorActionsEl = newer; });
  table.acknowledgeEdit(table.editIdentity);
  expect(old.remove).toHaveBeenCalledOnce(); expect(newer.remove).not.toHaveBeenCalled(); expect(table.mobileEditorActionsEl).toBe(newer);
});
