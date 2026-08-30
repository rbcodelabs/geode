import type { App } from "../../app";
import { valueToDisplayString } from "../../bases/coerce";
import type { BaseDefinition } from "../../bases/base-file";
import { columnDisplayName, frontmatterKeyForColumn, isEditableColumn } from "../../bases/columns";
import type { QueryGroup, QueryResult, QueryRow } from "../../bases/query-engine";
import { matchesSearch } from "../../bases/search-match";
import { cellsInSelection, moveCursor, type GridPos, type NavKey, type Selection } from "../../bases/table-nav";
import type { BaseValue } from "../../bases/value";
import type { TFile } from "../../types";
import { resolveTouchScrollAxis } from "../../bases/touch-scroll";

export type RowHeight = "short" | "medium" | "tall" | "extra tall";

export interface TableViewOptions {
  columns: string[];
  def: BaseDefinition;
  rowHeight: RowHeight;
  searchQuery: string;
}

export interface TableViewCallbacks {
  onOpenFile(file: TFile, newTab: boolean): void;
  /** Commit an edited cell's raw text back to the file's frontmatter. */
  onEditCell(file: TFile, columnPath: string, rawText: string): Promise<void>;
  onEditStart(file: TFile, columnPath: string, rawText: string): void;
  onEditDraft(rawText: string): void;
  onEditEnd(): void;
}

function cellValue(row: QueryRow, path: string): BaseValue | undefined {
  return row.properties[path];
}

function displayFor(row: QueryRow, path: string): string {
  const v = cellValue(row, path);
  return v ? valueToDisplayString(v) : "";
}

/**
 * Renders one Table view: columns from `view.order` (or all known
 * properties), optional group headers, a summaries footer row, and the
 * spec's full keyboard-nav/selection/inline-editing model. DOM-heavy by
 * nature — the coordinate math and search matching it calls into
 * (`table-nav.ts`/`search-match.ts`) are unit-tested separately.
 */
export class BasesTableView {
  containerEl: HTMLElement;
  private tableEl: HTMLTableElement;
  private theadEl: HTMLTableSectionElement;
  private tbodyEl: HTMLTableSectionElement;
  private tfootEl: HTMLTableSectionElement;

  private columns: string[] = [];
  private def: BaseDefinition | null = null;
  private dataRows: QueryRow[] = [];
  private dataRowEls: HTMLTableRowElement[] = [];
  private cellEls: HTMLTableCellElement[][] = []; // [row][col]

  private activeCell: GridPos | null = null;
  private selection: Selection = { type: "none" };
  private editing: GridPos | null = null;
  private mobileActionsEl: HTMLElement | null = null;
  private mobileEditorActionsEl: HTMLElement | null = null;
  private readonly resultLimitEl: HTMLElement | null;
  private readOnly = false;
  private suppressMouseSelectionUntil = 0;

  constructor(
    private app: App,
    private callbacks: TableViewCallbacks
  ) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "bases-table-container";
    this.containerEl.tabIndex = 0;
    this.tableEl = document.createElement("table");
    this.tableEl.className = "bases-table";
    this.theadEl = document.createElement("thead");
    this.tbodyEl = document.createElement("tbody");
    this.tfootEl = document.createElement("tfoot");
    this.tableEl.append(this.theadEl, this.tbodyEl, this.tfootEl);
    this.containerEl.appendChild(this.tableEl);
    this.resultLimitEl = document.body.classList.contains("is-mobile") ? document.createElement("div") : null;
    if (this.resultLimitEl) {
      this.resultLimitEl.className = "bases-result-limit";
      this.containerEl.appendChild(this.resultLimitEl);
    }
    this.containerEl.addEventListener("keydown", (e) => this.onKeyDown(e));
    if (document.body.classList.contains("is-mobile")) this.installTouchScrolling();
  }

  render(result: QueryResult, opts: TableViewOptions): void {
    this.columns = opts.columns;
    this.def = opts.def;
    this.containerEl.dataset.rowHeight = opts.rowHeight;

    this.theadEl.innerHTML = "";
    const headerRow = document.createElement("tr");
    for (const path of this.columns) {
      const th = document.createElement("th");
      th.textContent = columnDisplayName(opts.def, path);
      headerRow.appendChild(th);
    }
    this.theadEl.appendChild(headerRow);

    this.tbodyEl.innerHTML = "";
    this.dataRows = [];
    this.dataRowEls = [];
    this.cellEls = [];

    const passesSearch = (row: QueryRow) => matchesSearch(this.columns.map((p) => displayFor(row, p)), opts.searchQuery);

    const renderLimit = document.body.classList.contains("is-mobile") ? 200 : Number.POSITIVE_INFINITY;
    let rendered = 0;
    let total = 0;
    if (result.groups) {
      for (const group of result.groups) {
        const rows = group.rows.filter(passesSearch);
        total += rows.length;
        if (!rows.length || rendered >= renderLimit) continue;
        this.tbodyEl.appendChild(this.buildGroupHeaderRow(group));
        for (const row of rows) {
          if (rendered >= renderLimit) break;
          this.appendDataRow(row);
          rendered += 1;
        }
      }
    } else {
      const rows = result.rows.filter(passesSearch);
      total = rows.length;
      for (const row of rows.slice(0, renderLimit)) {
        this.appendDataRow(row);
        rendered += 1;
      }
    }
    if (this.resultLimitEl) {
      this.resultLimitEl.textContent = rendered < total ? `Showing ${rendered} of ${total} results` : "";
      this.resultLimitEl.style.display = rendered < total ? "" : "none";
    }

    this.tfootEl.innerHTML = "";
    if (Object.keys(result.summaries).length) {
      const summaryRow = document.createElement("tr");
      summaryRow.className = "bases-summary-row";
      for (const path of this.columns) {
        const td = document.createElement("td");
        const summary = result.summaries[path];
        td.textContent = summary ? valueToDisplayString(summary) : "";
        summaryRow.appendChild(td);
      }
      this.tfootEl.appendChild(summaryRow);
    }

    this.clampSelection();
    this.applySelectionClasses();
  }

  private buildGroupHeaderRow(group: QueryGroup): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.className = "bases-group-header-row";
    const td = document.createElement("td");
    td.colSpan = Math.max(1, this.columns.length);
    td.textContent = `${valueToDisplayString(group.key) || "(none)"} · ${group.rows.length}`;
    tr.appendChild(td);
    return tr;
  }

  private appendDataRow(row: QueryRow): void {
    const tr = document.createElement("tr");
    tr.className = "bases-data-row";
    const rowIndex = this.dataRows.length;
    const cells: HTMLTableCellElement[] = [];
    this.columns.forEach((path, colIndex) => {
      const td = document.createElement("td");
      td.className = "bases-cell";
      if (isEditableColumn(path)) td.classList.add("is-editable");
      td.textContent = displayFor(row, path);
      td.dataset.rowIndex = String(rowIndex);
      td.dataset.colIndex = String(colIndex);
      td.addEventListener("mousedown", (e) => {
        if (performance.now() < this.suppressMouseSelectionUntil) return;
        e.preventDefault();
        this.selectCell(rowIndex, colIndex);
      });
      td.addEventListener("dblclick", () => this.startEdit({ row: rowIndex, col: colIndex }));
      tr.appendChild(td);
      cells.push(td);
    });
    this.tbodyEl.appendChild(tr);
    this.dataRows.push(row);
    this.dataRowEls.push(tr);
    this.cellEls.push(cells);
  }

  private selectCell(row: number, col: number): void {
    if (this.readOnly) return;
    this.containerEl.focus();
    this.activeCell = { row, col };
    this.selection = { type: "cell", pos: this.activeCell };
    this.applySelectionClasses();
    this.renderMobileActions();
  }

  private clampSelection(): void {
    const rowCount = this.dataRows.length;
    const colCount = this.columns.length;
    if (rowCount === 0 || colCount === 0) {
      this.activeCell = null;
      this.selection = { type: "none" };
      return;
    }
    if (this.activeCell) {
      this.activeCell = {
        row: Math.min(this.activeCell.row, rowCount - 1),
        col: Math.min(this.activeCell.col, colCount - 1),
      };
    }
  }

  private applySelectionClasses(): void {
    const rowCount = this.dataRows.length;
    const colCount = this.columns.length;
    const selected = new Set(cellsInSelection(this.selection, rowCount, colCount).map((p) => `${p.row}:${p.col}`));
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < colCount; c++) {
        const el = this.cellEls[r][c];
        el.classList.toggle("is-selected", selected.has(`${r}:${c}`));
        el.classList.toggle("is-active", !!this.activeCell && this.activeCell.row === r && this.activeCell.col === c);
      }
    }
  }

  private currentFile(pos: GridPos): TFile {
    return this.dataRows[pos.row].file;
  }

  private startEdit(pos: GridPos): void {
    if (this.readOnly) return;
    const path = this.columns[pos.col];
    if (!isEditableColumn(path)) {
      if (path === "file.name") this.callbacks.onOpenFile(this.currentFile(pos), false);
      return;
    }
    this.editing = pos;
    const td = this.cellEls[pos.row][pos.col];
    const currentText = td.textContent ?? "";
    td.innerHTML = "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "bases-cell-input";
    input.value = currentText;
    td.appendChild(input);
    this.callbacks.onEditStart(this.currentFile(pos), path, currentText);
    input.addEventListener("input", () => this.callbacks.onEditDraft(input.value));
    input.focus();
    input.select();

    let committing = false;
    const commit = async () => {
      if (this.editing !== pos) return;
      if (committing) return;
      committing = true;
      input.disabled = true;
      try {
        await this.callbacks.onEditCell(this.currentFile(pos), path, input.value);
        this.editing = null;
        this.callbacks.onEditEnd();
        this.mobileEditorActionsEl?.remove();
        this.mobileEditorActionsEl = null;
      } catch {
        committing = false;
        input.disabled = false;
        input.focus();
      }
    };
    const cancel = () => {
      this.editing = null;
      this.callbacks.onEditEnd();
      td.textContent = currentText;
      this.mobileEditorActionsEl?.remove();
      this.mobileEditorActionsEl = null;
    };
    if (!document.body.classList.contains("is-mobile")) input.addEventListener("blur", () => { void commit(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
        this.containerEl.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
        this.containerEl.focus();
      }
      e.stopPropagation();
    });
    if (document.body.classList.contains("is-mobile")) {
      this.mobileActionsEl?.remove();
      const actions = document.createElement("div");
      actions.className = "bases-mobile-editor-actions";
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "Save";
      save.setAttribute("aria-label", "Save cell edit");
      save.addEventListener("click", () => { void commit(); });
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.textContent = "Cancel";
      cancelButton.setAttribute("aria-label", "Cancel cell edit");
      cancelButton.addEventListener("click", cancel);
      actions.append(save, cancelButton);
      this.containerEl.appendChild(actions);
      this.mobileEditorActionsEl = actions;
      input.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    const input = this.containerEl.querySelector<HTMLInputElement>(".bases-cell-input");
    if (input) input.disabled = readOnly;
    if (readOnly) this.mobileEditorActionsEl?.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  }

  acknowledgeEdit(): void {
    if (!this.editing) return;
    this.editing = null;
    this.callbacks.onEditEnd();
    this.mobileEditorActionsEl?.remove();
    this.mobileEditorActionsEl = null;
  }

  resetForFile(): void {
    this.editing = null;
    this.activeCell = null;
    this.selection = { type: "none" };
    this.mobileActionsEl?.remove();
    this.mobileActionsEl = null;
    this.mobileEditorActionsEl?.remove();
    this.mobileEditorActionsEl = null;
    this.readOnly = false;
  }

  private renderMobileActions(): void {
    if (!document.body.classList.contains("is-mobile") || !this.activeCell || this.editing) return;
    this.mobileActionsEl?.remove();
    const actions = document.createElement("div");
    actions.className = "bases-mobile-cell-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", "Edit selected cell");
    edit.disabled = !isEditableColumn(this.columns[this.activeCell.col]);
    edit.addEventListener("click", () => this.activeCell && this.startEdit(this.activeCell));
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open row";
    open.setAttribute("aria-label", "Open selected row");
    open.addEventListener("click", () => this.activeCell && this.callbacks.onOpenFile(this.currentFile(this.activeCell), false));
    actions.append(edit, open);
    this.containerEl.appendChild(actions);
    this.mobileActionsEl = actions;
  }

  private installTouchScrolling(): void {
    let gesture: { id: number; x: number; y: number; left: number; top: number; axis: "pending" | "x" | "y"; cell: HTMLElement | null } | null = null;
    this.containerEl.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch") return;
      this.suppressMouseSelectionUntil = performance.now() + 1_000;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, left: this.containerEl.scrollLeft, top: this.containerEl.scrollTop, axis: "pending", cell: (event.target as Element).closest<HTMLElement>(".bases-cell") };
    });
    this.containerEl.addEventListener("pointermove", (event) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (gesture.axis === "pending") gesture.axis = resolveTouchScrollAxis(dx, dy);
      if (gesture.axis === "pending") return;
      event.preventDefault();
      if (gesture.axis === "x") this.containerEl.scrollLeft = gesture.left - dx;
      else this.containerEl.scrollTop = gesture.top - dy;
    }, { passive: false });
    this.containerEl.addEventListener("pointerup", (event) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      if (gesture.axis === "pending" && gesture.cell) {
        this.selectCell(Number(gesture.cell.dataset.rowIndex), Number(gesture.cell.dataset.colIndex));
      }
      gesture = null;
    });
    this.containerEl.addEventListener("pointercancel", (event) => { if (gesture?.id === event.pointerId) gesture = null; });
  }

  private clearCells(cells: GridPos[]): void {
    for (const pos of cells) {
      const path = this.columns[pos.col];
      if (!isEditableColumn(path)) continue;
      if (!frontmatterKeyForColumn(path)) continue;
      this.callbacks.onEditCell(this.currentFile(pos), path, "");
    }
  }

  private async copySelection(): Promise<void> {
    const rowCount = this.dataRows.length;
    const colCount = this.columns.length;
    const cells = cellsInSelection(this.selection, rowCount, colCount);
    if (!cells.length) return;
    const minRow = Math.min(...cells.map((c) => c.row));
    const maxRow = Math.max(...cells.map((c) => c.row));
    const minCol = Math.min(...cells.map((c) => c.col));
    const maxCol = Math.max(...cells.map((c) => c.col));
    const lines: string[] = [];
    for (let r = minRow; r <= maxRow; r++) {
      const cols: string[] = [];
      for (let c = minCol; c <= maxCol; c++) cols.push(displayFor(this.dataRows[r], this.columns[c]));
      lines.push(cols.join("\t"));
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
    } catch {
      // Clipboard access denied/unavailable — silently no-op rather than throw into a keydown handler.
    }
  }

  private async pasteAtActiveCell(): Promise<void> {
    if (!this.activeCell) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    lines.forEach((line, dr) => {
      const row = this.activeCell!.row + dr;
      if (row >= this.dataRows.length) return;
      line.split("\t").forEach((value, dc) => {
        const col = this.activeCell!.col + dc;
        if (col >= this.columns.length) return;
        const path = this.columns[col];
        if (!isEditableColumn(path)) return;
        this.callbacks.onEditCell(this.dataRows[row].file, path, value);
      });
    });
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.editing) return; // input's own handler manages Enter/Escape while editing
    if (!this.activeCell) {
      if (this.dataRows.length && this.columns.length) {
        this.activeCell = { row: 0, col: 0 };
        this.selection = { type: "cell", pos: this.activeCell };
        this.applySelectionClasses();
      }
      return;
    }

    const rowCount = this.dataRows.length;
    const colCount = this.columns.length;

    const navKeys: Record<string, NavKey> = {
      ArrowUp: "ArrowUp",
      ArrowDown: "ArrowDown",
      ArrowLeft: "ArrowLeft",
      ArrowRight: "ArrowRight",
      Home: "Home",
      End: "End",
    };

    if (e.key === "Tab") {
      e.preventDefault();
      this.activeCell = moveCursor(this.activeCell, e.shiftKey ? "ShiftTab" : "Tab", rowCount, colCount);
      this.selection = { type: "cell", pos: this.activeCell };
      this.applySelectionClasses();
      return;
    }

    if (e.key in navKeys) {
      e.preventDefault();
      this.activeCell = moveCursor(this.activeCell, navKeys[e.key], rowCount, colCount);
      this.selection = { type: "cell", pos: this.activeCell };
      this.applySelectionClasses();
      return;
    }

    if (e.code === "Space" && e.ctrlKey) {
      e.preventDefault();
      this.selection = { type: "column", col: this.activeCell.col };
      this.applySelectionClasses();
      return;
    }

    if (e.code === "Space" && e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      this.selection = { type: "row", row: this.activeCell.row };
      this.applySelectionClasses();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      this.startEdit(this.activeCell);
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      this.selection = { type: "none" };
      this.applySelectionClasses();
      return;
    }

    if (e.key === "Backspace") {
      e.preventDefault();
      this.clearCells(cellsInSelection(this.selection, rowCount, colCount));
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void this.copySelection();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      void this.pasteAtActiveCell();
      return;
    }
  }
}
