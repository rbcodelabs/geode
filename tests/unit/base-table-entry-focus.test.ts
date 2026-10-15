import { expect, it, vi } from "vitest";
import { BasesTableView } from "../../src/renderer/views/bases/table-view";

function fixture() {
  const handlers = new Map<string, (event: any) => void>();
  const table = Object.create(BasesTableView.prototype) as any;
  const ancestor = { scrollTop: 135 };
  const focus = vi.fn((options?: FocusOptions) => { if (!options?.preventScroll) ancestor.scrollTop = 0; });
  Object.assign(table, {
    containerEl: { focus, scrollTop: 17, scrollLeft: 23, addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler) },
    applySelectionClasses: vi.fn(), renderMobileActions: vi.fn(), activeCell: null,
    columns: ["file.name", "note.priority"], dataRows: [{}, {}], editing: null,
    callbacks: { onEditCell: vi.fn(), onEditStart: vi.fn(), onEditEnd: vi.fn() },
  });
  return { table, focus, handlers, ancestor };
}
it("focuses the selected pointer cell without scrolling its nested ancestors or submitting an edit", () => {
  const { table, focus, ancestor } = fixture();
  table.selectCell(1, 1);
  expect(focus).toHaveBeenCalledOnce(); expect(ancestor.scrollTop).toBe(135);
  expect(table.activeCell).toEqual({ row: 1, col: 1 });
  expect(table.selection).toEqual({ type: "cell", pos: { row: 1, col: 1 } });
  expect(table.applySelectionClasses).toHaveBeenCalledOnce();
  expect(table.callbacks.onEditCell).not.toHaveBeenCalled();
  expect(table.callbacks.onEditStart).not.toHaveBeenCalled();
  expect(table.callbacks.onEditEnd).not.toHaveBeenCalled();
});
it("preserves read-only refusal before moving focus or selection", () => {
  const { table, focus } = fixture(); table.readOnly = true;
  table.selectCell(1, 1);
  expect(focus).not.toHaveBeenCalled(); expect(table.activeCell).toBeNull();
});
it("keeps keyboard navigation on the selected grid without taking focus again", () => {
  const { table, focus } = fixture(); table.selectCell(0, 0); focus.mockClear();
  const preventDefault = vi.fn(); table.onKeyDown({ key: "ArrowRight", preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce(); expect(table.activeCell).toEqual({ row: 0, col: 1 });
  expect(focus).not.toHaveBeenCalled(); expect(table.callbacks.onEditCell).not.toHaveBeenCalled();
});
it.each(["tap", "drag"])("preserves touch %s selection versus scroll arbitration", kind => {
  const { table, focus, handlers, ancestor } = fixture(); table.installTouchScrolling();
  const cell = { dataset: { rowIndex: "1", colIndex: "1" } };
  handlers.get("pointerdown")!({ pointerType: "touch", pointerId: 4, clientX: 20, clientY: 20, target: { closest: () => cell } });
  if (kind === "drag") handlers.get("pointermove")!({ pointerId: 4, clientX: 50, clientY: 22, preventDefault: vi.fn() });
  handlers.get("pointerup")!({ pointerId: 4 });
  if (kind === "tap") {
    expect(table.activeCell).toEqual({ row: 1, col: 1 }); expect(focus).toHaveBeenCalledOnce(); expect(ancestor.scrollTop).toBe(135);
  } else {
    expect(table.activeCell).toBeNull(); expect(focus).not.toHaveBeenCalled(); expect(table.containerEl.scrollLeft).toBe(-7);
  }
  expect(table.callbacks.onEditCell).not.toHaveBeenCalled();
});
