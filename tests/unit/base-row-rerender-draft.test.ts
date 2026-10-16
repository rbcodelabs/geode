import { afterEach, expect, it, vi } from "vitest";
import { BaseView } from "../../src/renderer/views/base-view";
import { BasesTableView } from "../../src/renderer/views/bases/table-view";
const query = vi.hoisted(() => ({ calls: 0, result: { rows: [], summaries: {} } }));
vi.mock("../../src/renderer/bases/query-engine", () => ({ runQuery: () => { query.calls++; return query.result; } }));
afterEach(() => vi.unstubAllGlobals());
class El {
  children: El[] = []; parent: El | null = null; root = false; dataset = {}; style = {}; textContent = "2"; value = "";
  handlers: Record<string, (event?: any) => void> = {}; classList = { add() {}, toggle() {}, contains: () => false };
  get isConnected(): boolean { return this.root || !!this.parent?.isConnected; }
  set innerHTML(_value: string) { for (const child of this.children) child.parent = null; this.children = []; }
  appendChild(child: El) { child.parent = this; this.children.push(child); }
  addEventListener(name: string, callback: (event?: any) => void) { this.handlers[name] = callback; }
  focus() {} select() {}
}
it("keeps an active draft's real table input connected during an unrelated query refresh", () => {
  vi.stubGlobal("document", { createElement: () => new El(), body: new El() });
  const table = Object.create(BasesTableView.prototype) as any; const root = new El(); root.root = true;
  const body = new El(); const row = new El(); const cell = new El(); root.appendChild(body); body.appendChild(row); row.appendChild(cell);
  const base = Object.create(BaseView.prototype) as any;
  const definition = { views: [{ type: "table", name: "Table", order: ["note.priority"] }], formulas: {}, properties: {} };
  Object.assign(base, { sourceEdit: null, tableView: table, cardsView: { containerEl: new El() }, pluginViewHost: { registrationFor: () => undefined, hide() {} }, def: definition, file: { path: "Tasks.base" }, currentView: () => definition.views[0], currentViewName: "Table", knownPropertyKeys: () => ["priority"], creatableViewTypes: () => [], rowHeights: new Map(), toolbar: { update() {} }, clearError() {}, app: { vault: { read: async () => "original", getMarkdownFiles: () => [] }, metadataCache: {} } });
  Object.assign(table, { containerEl: root, theadEl: new El(), tbodyEl: body, tfootEl: new El(), columns: ["note.priority"], dataRows: [{ file: { path: "Note.md" } }], cellEls: [[cell]], activeCell: null, selection: { type: "none" }, callbacks: { onEditStart: (file: any, column: string, text: string) => base.beginSourceEdit(file, column, text), onEditDraft: (text: string) => { base.sourceEdit.rawText = text; }, onEditCell: async () => {}, onEditEnd: (identity: object) => base.endSourceEdit(identity) } });
  table.startEdit({ row: 0, col: 0 }); const input = cell.children[0]; input.value = "9"; input.handlers.input();
  expect(input.isConnected).toBe(true);
  query.calls = 0; base.runAndRender(); base.runAndRender();
  expect(query.calls).toBe(0);
  expect(base.sourceEdit.rawText).toBe("9"); expect(input.isConnected).toBe(true);
  input.handlers.keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  expect(input.isConnected).toBe(false); expect(base.sourceEdit).toBeNull(); expect(query.calls).toBe(1);
});
