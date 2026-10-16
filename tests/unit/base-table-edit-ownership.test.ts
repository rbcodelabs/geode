import { afterEach, expect, it, vi } from "vitest";
import { BasesTableView } from "../../src/renderer/views/bases/table-view";
afterEach(() => vi.unstubAllGlobals());
function element(): any { return { children: [] as any[], handlers: {} as Record<string, (event?: any) => void>, dataset: {}, textContent: "2", setAttribute() {}, scrollIntoView() {}, remove() {}, append(...children: any[]) { this.children.push(...children); }, classList: { contains: () => false }, focus: vi.fn(), select() {}, addEventListener(name: string, callback: (event?: any) => void) { this.handlers[name] = callback; }, appendChild(child: any) { this.children.push(child); } }; }
function fixture() {
  vi.stubGlobal("document", { createElement: element, body: element() });
  const table = Object.create(BasesTableView.prototype) as any;
  const a = element(); const b = element(); const onEditEnd = vi.fn();
  const callbacks = { onEditStart: vi.fn(() => ({})), onEditDraft: vi.fn(), onEditEnd, onEditCell: vi.fn(async () => {}) };
  Object.assign(table, { readOnly: false, containerEl: element(), columns: ["note.priority"], dataRows: [{ file: { path: "A.md" } }, { file: { path: "B.md" } }], cellEls: [[a], [b]], callbacks });
  return { table, a, b, callbacks, onEditEnd };
}
const event = (key: string) => ({ key, preventDefault() {}, stopPropagation() {} });
it("selecting a visible cell keeps nested native scroll positions while focusing its table", () => {
  const { table } = fixture();
  const canvas = { scrollLeft: 7, scrollTop: 11 }, note = { scrollTop: 23 };
  table.applySelectionClasses = vi.fn(); table.renderMobileActions = vi.fn();
  table.containerEl.focus.mockImplementation((options?: FocusOptions) => {
    (document as any).activeElement = table.containerEl;
    // Model the browser's observed ancestor scrolling when ordinary focus is
    // requested for the larger table, even though the clicked cell is visible.
    if (!options?.preventScroll) { canvas.scrollTop = 34; note.scrollTop = 67; }
  });
  table.selectCell(0, 0);
  expect(document.activeElement).toBe(table.containerEl);
  expect(table.activeCell).toEqual({ row: 0, col: 0 });
  expect(canvas).toEqual({ scrollLeft: 7, scrollTop: 11 });
  expect(note.scrollTop).toBe(23);
  expect(table.applySelectionClasses).toHaveBeenCalledOnce();
});
it.each(["success", "failure"])("does not let an older %s completion end or refocus a newer table editor", async outcome => {
  const { table, a, b, callbacks, onEditEnd } = fixture(); let finish!: () => void;
  callbacks.onEditCell.mockImplementation(() => new Promise<void>((resolve, reject) => { finish = () => outcome === "success" ? resolve() : reject(new Error("old row failed")); }));
  table.startEdit({ row: 0, col: 0 }); const inputA = a.children[0]; inputA.value = "9"; inputA.handlers.keydown(event("Enter"));
  const newer = { row: 1, col: 0 }; table.startEdit(newer); const inputB = b.children[0]; inputB.value = "10";
  finish(); await new Promise(resolve => setImmediate(resolve));
  expect(table.editing).toBe(newer); expect(inputB.value).toBe("10"); expect(onEditEnd).not.toHaveBeenCalled();
  expect(inputA.focus).toHaveBeenCalledOnce(); expect(inputB.focus).toHaveBeenCalledOnce();
});
it("Enter submits the captured draft and focuses its table without scrolling native ancestors", () => {
  const { table, a, callbacks } = fixture();
  callbacks.onEditCell.mockImplementation(() => new Promise<void>(() => {}));
  const canvas = { scrollTop: 0 }, note = { scrollTop: 0 };
  table.containerEl.focus.mockImplementation((options?: FocusOptions) => {
    (document as any).activeElement = table.containerEl;
    if (!options?.preventScroll) { canvas.scrollTop = 34; note.scrollTop = 67; }
  });
  table.startEdit({ row: 0, col: 0 }); const input = a.children[0]; input.value = "9";
  input.handlers.keydown(event("Enter"));
  expect(callbacks.onEditCell).toHaveBeenCalledWith({ path: "A.md" }, "note.priority", "9");
  expect(document.activeElement).toBe(table.containerEl);
  expect(table.editIdentity).not.toBeNull(); expect(input.value).toBe("9"); expect(input.disabled).toBe(true);
  expect(canvas.scrollTop).toBe(0); expect(note.scrollTop).toBe(0);
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
it.each(["Enter", "Escape"])("ignores stale %s focus changes after a newer editor starts", key => {
  const { table, a } = fixture(); table.startEdit({ row: 0, col: 0 }); const old = a.children[0];
  table.startEdit({ row: 1, col: 0 }); const current = table.editIdentity;
  old.handlers.keydown(event(key)); expect(table.containerEl.focus).not.toHaveBeenCalled(); expect(table.editIdentity).toBe(current);
});
it("ignores stale blur before consulting replaced rows", () => {
  const { table, a } = fixture(); table.startEdit({ row: 0, col: 0 }); const old = a.children[0]; table.resetForFile(); table.dataRows = [];
  const owner = {}; table.containerEl.closest = () => owner;
  const retry = { closest: () => owner, dataset: { baseRowRetry: JSON.stringify(["A.md", "note.priority"]) } };
  expect(() => old.handlers.blur({ relatedTarget: { closest: () => retry } })).not.toThrow();
});
it("does not reenable or refocus a failed input after the table becomes read-only", async () => {
  const { table, a, callbacks } = fixture(); let reject!: (error: Error) => void;
  callbacks.onEditCell.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  table.startEdit({ row: 0, col: 0 }); const input = a.children[0]; input.handlers.keydown(event("Enter"));
  table.readOnly = true; reject(new Error("rejected after conflict")); await new Promise(resolve => setImmediate(resolve));
  expect(input.disabled).toBe(true); expect(input.focus).toHaveBeenCalledOnce();
});

it("keeps the user's chosen control focused after a failed blur save", async () => {
  const { table, a, callbacks, onEditEnd } = fixture(); table.containerEl.closest = () => null;
  callbacks.onEditCell.mockRejectedValue(new Error("blur write failed"));
  table.startEdit({ row: 0, col: 0 }); const input = a.children[0]; input.value = "9";
  const destination = element(); destination.closest = () => null; (document as any).activeElement = destination;
  input.handlers.blur({ relatedTarget: destination }); await new Promise(resolve => setImmediate(resolve));
  expect(callbacks.onEditCell).toHaveBeenCalledWith({ path: "A.md" }, "note.priority", "9");
  expect(input.focus).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(destination);
  expect(input.value).toBe("9"); expect(input.disabled).toBe(false); expect(table.editIdentity).not.toBeNull(); expect(onEditEnd).not.toHaveBeenCalled();
});
it("still refocuses the exact failed Enter draft while its table retains focus", async () => {
  const { table, a, callbacks } = fixture(); callbacks.onEditCell.mockRejectedValue(new Error("Enter write failed"));
  table.startEdit({ row: 0, col: 0 }); const input = a.children[0]; (document as any).activeElement = input;
  input.handlers.keydown(event("Enter")); (document as any).activeElement = table.containerEl;
  await new Promise(resolve => setImmediate(resolve)); expect(input.focus).toHaveBeenCalledTimes(2); expect(table.editIdentity).not.toBeNull();
});
it("does not reclaim focus when the user leaves during an explicit pending save", async () => {
  const { table, a, callbacks } = fixture(); let reject!: (error: Error) => void;
  callbacks.onEditCell.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  table.startEdit({ row: 0, col: 0 }); const input = a.children[0]; (document as any).activeElement = input;
  input.handlers.keydown(event("Enter")); const destination = element(); (document as any).activeElement = destination;
  reject(new Error("late explicit failure")); await new Promise(resolve => setImmediate(resolve));
  expect(input.focus).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(destination); expect(table.editIdentity).not.toBeNull();
});
it("keeps explicit mobile Save focus recovery for the exact failed draft", async () => {
  const { table, a, callbacks, onEditEnd } = fixture(); (document.body as any).classList.contains = (name: string) => name === "is-mobile";
  callbacks.onEditCell.mockRejectedValue(new Error("mobile write failed")); table.startEdit({ row: 0, col: 0 });
  const input = a.children[0]; input.value = "9"; const save = table.containerEl.children[0].children[0];
  (document as any).activeElement = save; save.handlers.click(); await new Promise(resolve => setImmediate(resolve));
  expect(input.focus).toHaveBeenCalledTimes(2); expect(input.value).toBe("9"); expect(input.disabled).toBe(false); expect(onEditEnd).not.toHaveBeenCalled();
});
it("finishes a successful blur save without reclaiming focus or changing its captured value", async () => {
  const { table, a, callbacks, onEditEnd } = fixture(); table.containerEl.closest = () => null;
  table.startEdit({ row: 0, col: 0 }); const input = a.children[0]; input.value = "9";
  const destination = element(); destination.closest = () => null; (document as any).activeElement = destination;
  input.handlers.blur({ relatedTarget: destination }); await new Promise(resolve => setImmediate(resolve));
  expect(callbacks.onEditCell).toHaveBeenCalledWith({ path: "A.md" }, "note.priority", "9"); expect(onEditEnd).toHaveBeenCalledOnce();
  expect(input.focus).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(destination); expect(table.editIdentity).toBeNull();
});
it("does not create an editor or write from a read-only table", () => {
  const { table, a, callbacks } = fixture(); table.readOnly = true; table.startEdit({ row: 0, col: 0 });
  expect(a.children).toEqual([]); expect(callbacks.onEditStart).not.toHaveBeenCalled(); expect(callbacks.onEditCell).not.toHaveBeenCalled();
});
