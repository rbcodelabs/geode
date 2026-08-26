import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { EditorState, Extension, Range, RangeSet, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { App } from "../app";
import { setIcon } from "../api/icons";
import { CanvasView } from "../views/canvas-view";
import { calloutMarkerLength, calloutMeta, parseCalloutHeader, type CalloutMeta } from "./callout";
import { loadEmbedBlobUrl, parseEmbedDims, resolveEmbed } from "./embed";
import { parseTable, serializeTable, type Align, type ParsedTable } from "./table";

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** Length of doc prefix scanned for frontmatter. */
const FM_SCAN = 8192;

function frontmatterRange(docPrefix: string): { end: number; yaml: string } | null {
  const m = docPrefix.match(FM_RE);
  if (!m) return null;
  return { end: m[0].length - (m[2]?.length ?? 0), yaml: m[1] };
}

/**
 * Returns the doc offset just past the frontmatter block in `text`, or
 * `null` if `text` has no frontmatter. Scans the same bounded prefix that
 * `computeFrontmatter()` uses, so results stay consistent with the widget's
 * replaced range.
 *
 * `frontmatterRange().end` stops right after the closing `---` delimiter,
 * before its trailing newline — that's the right boundary for the widget's
 * replaced range and the atomic range, but it's still on the frontmatter's
 * last line. Landing a cursor exactly there renders it at the block
 * widget's full height (CodeMirror treats the position as belonging to the
 * replaced line). Advance past the trailing newline, if any, so the cursor
 * lands on the real line that follows the frontmatter block.
 */
export function frontmatterEndOffset(text: string): number | null {
  const prefix = text.slice(0, Math.min(text.length, FM_SCAN));
  const fm = frontmatterRange(prefix);
  if (!fm) return null;
  const trailingNewline = prefix.slice(fm.end).match(/^\r?\n/);
  return trailingNewline ? fm.end + trailingNewline[0].length : fm.end;
}

// --- Properties (frontmatter) widget ---------------------------------------

class PropertiesWidget extends WidgetType {
  constructor(
    private yamlText: string,
    private app: App
  ) {
    super();
  }

  eq(other: PropertiesWidget): boolean {
    return other.yamlText === this.yamlText;
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    // IMPORTANT: block widgets are measured via getBoundingClientRect(),
    // which excludes margins — all spacing must live inside this box
    // (padding only), or CodeMirror's height map drifts and cursor
    // motion/clicks land on the wrong lines.
    const root = document.createElement("div");
    root.className = "metadata-properties";
    const inner = document.createElement("div");
    inner.className = "metadata-properties-inner";
    root.appendChild(inner);
    let obj: Record<string, unknown> = {};
    try {
      const parsed = parseYaml(this.yamlText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      root.classList.add("has-invalid-yaml");
    }

    const heading = document.createElement("div");
    heading.className = "metadata-properties-heading";
    heading.textContent = "Properties";
    inner.appendChild(heading);

    const commit = () => writeFrontmatter(view, obj);

    for (const [key, value] of Object.entries(obj)) {
      inner.appendChild(this.renderRow(key, value, obj, commit));
    }

    // "Add property" row
    const addRow = document.createElement("div");
    addRow.className = "metadata-add-button";
    addRow.textContent = "+ Add property";
    addRow.addEventListener("click", () => {
      addRow.replaceWith(this.renderNewRow(obj, commit));
    });
    inner.appendChild(addRow);
    return root;
  }

  private typeIcon(value: unknown): string {
    if (Array.isArray(value)) return "≡";
    if (typeof value === "boolean") return "☑";
    if (typeof value === "number") return "#";
    return "Aa";
  }

  private renderRow(
    key: string,
    value: unknown,
    obj: Record<string, unknown>,
    commit: () => void
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "metadata-property";

    const keyEl = document.createElement("div");
    keyEl.className = "metadata-property-key";
    keyEl.innerHTML = `<span class="metadata-property-icon">${this.typeIcon(value)}</span>`;
    const keyInput = document.createElement("input");
    keyInput.className = "metadata-input metadata-key-input";
    keyInput.value = key;
    keyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") keyInput.blur();
    });
    keyInput.addEventListener("blur", () => {
      const newKey = keyInput.value.trim();
      if (!newKey || newKey === key) {
        keyInput.value = key;
        return;
      }
      // Preserve property order while renaming.
      const entries = Object.entries(obj).map(([k, v]) => (k === key ? [newKey, v] : [k, v]));
      for (const k of Object.keys(obj)) delete obj[k];
      for (const [k, v] of entries) obj[k as string] = v;
      commit();
    });
    keyEl.appendChild(keyInput);

    const valueEl = document.createElement("div");
    valueEl.className = "metadata-property-value";
    valueEl.appendChild(this.renderValueInput(key, value, obj, commit));

    const removeBtn = document.createElement("div");
    removeBtn.className = "metadata-property-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove property";
    removeBtn.addEventListener("click", () => {
      delete obj[key];
      commit();
    });

    row.appendChild(keyEl);
    row.appendChild(valueEl);
    row.appendChild(removeBtn);
    return row;
  }

  private renderValueInput(
    key: string,
    value: unknown,
    obj: Record<string, unknown>,
    commit: () => void
  ): HTMLElement {
    if (typeof value === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value;
      input.addEventListener("change", () => {
        obj[key] = input.checked;
        commit();
      });
      return input;
    }
    const input = document.createElement("input");
    input.className = "metadata-input";
    if (Array.isArray(value)) {
      input.value = value.map(String).join(", ");
      input.placeholder = "comma, separated, values";
    } else if (typeof value === "number") {
      input.type = "number";
      input.value = String(value);
    } else {
      input.value = value == null ? "" : String(value);
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    });
    input.addEventListener("blur", () => {
      let next: unknown = input.value;
      if (Array.isArray(value)) {
        next = input.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (typeof value === "number") {
        const n = Number(input.value);
        next = Number.isFinite(n) ? n : input.value;
      }
      if (JSON.stringify(next) === JSON.stringify(value)) return;
      obj[key] = next;
      commit();
    });
    return input;
  }

  private renderNewRow(obj: Record<string, unknown>, commit: () => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "metadata-property is-new";
    const keyInput = document.createElement("input");
    keyInput.className = "metadata-input metadata-key-input";
    keyInput.placeholder = "name";
    const valInput = document.createElement("input");
    valInput.className = "metadata-input";
    valInput.placeholder = "value";
    const save = () => {
      const k = keyInput.value.trim();
      if (!k) return;
      let v: unknown = valInput.value;
      if (v === "true") v = true;
      else if (v === "false") v = false;
      else if (v !== "" && !Number.isNaN(Number(v))) v = Number(v);
      obj[k] = v;
      commit();
    };
    for (const input of [keyInput, valInput]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
      });
    }
    valInput.addEventListener("blur", () => window.setTimeout(save, 100));
    row.appendChild(keyInput);
    row.appendChild(valInput);
    window.setTimeout(() => keyInput.focus(), 0);
    return row;
  }
}

function writeFrontmatter(view: EditorView, obj: Record<string, unknown>) {
  const prefix = view.state.doc.sliceString(0, Math.min(view.state.doc.length, FM_SCAN));
  const fm = frontmatterRange(prefix);
  const hasProps = Object.keys(obj).length > 0;
  const insert = hasProps ? `---\n${stringifyYaml(obj)}---` : "";
  if (fm) {
    // When removing the last property also swallow the trailing newline.
    const to = hasProps ? fm.end : Math.min(view.state.doc.length, fm.end + 1);
    view.dispatch({ changes: { from: 0, to, insert } });
  } else if (hasProps) {
    view.dispatch({ changes: { from: 0, to: 0, insert: insert + "\n" } });
  }
}

// --- Inline widgets ---------------------------------------------------------

class CheckboxWidget extends WidgetType {
  constructor(
    private checked: boolean,
    private pos: number
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-checkbox";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: this.checked ? "[ ]" : "[x]" },
      });
    });
    return box;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class HRWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-hr-widget";
    el.innerHTML = "<hr>";
    return el;
  }
}

/** Replaces a callout header's `[!type]+/-` marker with its Lucide icon (title text stays untouched, editable). */
class CalloutIconWidget extends WidgetType {
  constructor(private iconId: string) {
    super();
  }

  eq(other: CalloutIconWidget): boolean {
    return other.iconId === this.iconId;
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-callout-icon";
    setIcon(span, this.iconId);
    return span;
  }
}

/** Alignment cycle order used by the per-column header toggle (default → left → center → right → …). */
const ALIGN_CYCLE: Align[] = [null, "left", "center", "right"];

/**
 * Renders a GFM pipe-table block as an always-on, in-place editable `<table>`
 * in Live Preview — mirroring PropertiesWidget's frontmatter editor. Unlike
 * the other Live Preview widgets, this one never reverts to raw markdown when
 * the cursor is near it (the block is added to `EditorView.atomicRanges` so
 * the cursor skips over it); editing happens entirely through the real
 * `<input>` elements it renders per cell, and every change is written back to
 * the document via a single `view.dispatch` over the table's `[from, to)`
 * range (see `commit()`), exactly like `writeFrontmatter()`.
 *
 * The widget owns its DOM: it keeps an in-memory `ParsedTable` model and
 * mutates the live DOM directly on structural edits, rather than relying on
 * CodeMirror to rebuild it. `eq()` compares the serialized `raw` (and is
 * kept true across the widget's own commits by updating `this.raw` *before*
 * dispatching) so CM6 reuses this DOM — and its focus — instead of throwing
 * it away mid-edit.
 */
class TableWidget extends WidgetType {
  private root: HTMLElement | null = null;
  private view: EditorView | null = null;
  /** Live per-cell inputs, indexed `[rowKey][col]` where rowKey 0 = header, 1.. = data rows. */
  private cellInputs: HTMLInputElement[][] = [];

  constructor(
    private raw: string,
    private table: ParsedTable
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    // Compare raw so CM6 reuses our DOM (and its focus) across the recompute
    // our own commit triggers. This is deliberately *pure*: it used to sync
    // `from`/`to` from the incoming widget as a side effect, which was
    // unsound. `RangeSet.compare` calls `oldWidget.eq(newWidget)` where "old"
    // is the previous decoration set — from the second recompute onwards that
    // is an orphan widget that never owned any DOM, so the live, DOM-owning
    // widget stopped being synced and `commit()` wrote over the wrong slice
    // of the document. `commit()` now derives the range from the DOM instead
    // (see below), so there is nothing to sync here.
    return other.raw === this.raw;
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    // IMPORTANT: block widgets are measured via getBoundingClientRect(),
    // which excludes margins (see PropertiesWidget above) — spacing here
    // uses padding on the root, with the inner table's own margin zeroed
    // out in CSS, to keep CodeMirror's height map accurate.
    this.view = view;
    const root = document.createElement("div");
    root.className = "cm-table-widget markdown-rendered";
    this.root = root;
    this.render();
    return root;
  }

  // --- Model → DOM -----------------------------------------------------------

  /** Rebuilds the widget's DOM children from the current `this.table` model. */
  private render(): void {
    const root = this.root;
    if (!root) return;
    root.replaceChildren();
    this.cellInputs = [];
    const cols = this.table.header.length;

    const tableEl = document.createElement("table");

    const thead = document.createElement("thead");
    const headTr = document.createElement("tr");
    const headerInputs: HTMLInputElement[] = [];
    this.table.header.forEach((cell, c) => {
      const th = document.createElement("th");
      this.applyAlign(th, this.table.align[c]);
      const input = this.buildCellInput(cell, 0, c);
      th.appendChild(input);
      th.appendChild(this.buildColControls(c));
      headerInputs.push(input);
      headTr.appendChild(th);
    });
    headTr.appendChild(this.buildAddColCell());
    thead.appendChild(headTr);
    tableEl.appendChild(thead);
    this.cellInputs.push(headerInputs);

    const tbody = document.createElement("tbody");
    this.table.rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      const rowInputs: HTMLInputElement[] = [];
      for (let c = 0; c < cols; c++) {
        const td = document.createElement("td");
        this.applyAlign(td, this.table.align[c]);
        const input = this.buildCellInput(row[c] ?? "", r + 1, c);
        td.appendChild(input);
        rowInputs.push(input);
        tr.appendChild(td);
      }
      tr.appendChild(this.buildRowControlCell(r));
      tbody.appendChild(tr);
      this.cellInputs.push(rowInputs);
    });
    tableEl.appendChild(tbody);
    root.appendChild(tableEl);

    const addRow = document.createElement("div");
    addRow.className = "cm-table-addrow";
    addRow.textContent = "+ Add row";
    addRow.title = "Add row";
    addRow.addEventListener("mousedown", (e) => e.preventDefault());
    addRow.addEventListener("click", () => this.addRow());
    root.appendChild(addRow);
  }

  private applyAlign(cell: HTMLElement, align: Align): void {
    cell.style.textAlign = align ?? "";
  }

  private buildCellInput(value: string, rowKey: number, col: number): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "cm-table-cell-input";
    input.value = value;
    input.style.textAlign = this.table.align[col] ?? "";
    input.addEventListener("input", () => this.setCell(rowKey, col, input.value));
    input.addEventListener("blur", () => this.commit());
    input.addEventListener("keydown", (e) => this.onCellKeydown(e, rowKey, col));
    return input;
  }

  private buildColControls(col: number): HTMLElement {
    const ctl = document.createElement("div");
    ctl.className = "cm-table-col-controls";

    const alignBtn = this.controlButton(this.alignLabel(this.table.align[col]), () =>
      this.cycleAlign(col)
    );
    alignBtn.classList.add("cm-table-align-btn");
    alignBtn.title = `Align: ${this.table.align[col] ?? "default"} (click to cycle)`;

    const delBtn = this.controlButton("×", () => this.deleteColumn(col));
    delBtn.classList.add("cm-table-del-btn");
    delBtn.title = "Delete column";

    ctl.appendChild(alignBtn);
    ctl.appendChild(delBtn);
    return ctl;
  }

  private buildAddColCell(): HTMLElement {
    const th = document.createElement("th");
    th.className = "cm-table-addcol";
    const btn = this.controlButton("+", () => this.addColumn());
    btn.title = "Add column";
    th.appendChild(btn);
    return th;
  }

  private buildRowControlCell(row: number): HTMLElement {
    const td = document.createElement("td");
    td.className = "cm-table-rowctl";
    const btn = this.controlButton("×", () => this.deleteRow(row));
    btn.title = "Delete row";
    td.appendChild(btn);
    return td;
  }

  private controlButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-table-ctl-btn";
    btn.textContent = label;
    // Keep the caret in the currently-focused cell (its value is already in
    // the model via 'input'); we drive focus explicitly after the mutation.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
    return btn;
  }

  private alignLabel(align: Align): string {
    return align === "left" ? "L" : align === "center" ? "C" : align === "right" ? "R" : "–";
  }

  // --- Editing ---------------------------------------------------------------

  private setCell(rowKey: number, col: number, value: string): void {
    if (rowKey === 0) this.table.header[col] = value;
    else this.table.rows[rowKey - 1][col] = value;
  }

  private onCellKeydown(e: KeyboardEvent, rowKey: number, col: number): void {
    if (e.key === "Tab") {
      e.preventDefault();
      this.moveCell(rowKey, col, e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.moveRow(rowKey, col, e.shiftKey ? -1 : 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      this.moveRow(rowKey, col, 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.moveRow(rowKey, col, -1);
    }
  }

  /** Tab / Shift+Tab: move to the next / previous cell in reading order, wrapping across rows. */
  private moveCell(rowKey: number, col: number, dir: 1 | -1): void {
    const cols = this.table.header.length;
    const lastRowKey = this.table.rows.length; // header = 0, data rows 1..N
    let nextCol = col + dir;
    let nextRow = rowKey;
    if (nextCol >= cols) {
      nextCol = 0;
      nextRow = rowKey >= lastRowKey ? 0 : rowKey + 1;
    } else if (nextCol < 0) {
      nextCol = cols - 1;
      nextRow = rowKey <= 0 ? lastRowKey : rowKey - 1;
    }
    this.focusCell(nextRow, nextCol);
  }

  /** Enter / arrows: move to the same column of the next / previous row (clamped). */
  private moveRow(rowKey: number, col: number, dir: 1 | -1): void {
    const lastRowKey = this.table.rows.length;
    this.focusCell(Math.min(lastRowKey, Math.max(0, rowKey + dir)), col);
  }

  private focusCell(rowKey: number, col: number): void {
    const row = this.cellInputs[rowKey];
    if (!row) return;
    const input = row[Math.min(col, row.length - 1)];
    if (input) {
      input.focus();
      input.select();
    }
  }

  private addRow(): void {
    const cols = this.table.header.length;
    this.table.rows.push(new Array(cols).fill(""));
    this.render();
    this.commit();
    this.focusCell(this.table.rows.length, 0);
  }

  private deleteRow(row: number): void {
    if (this.table.rows.length <= 1) return; // keep at least one data row
    this.table.rows.splice(row, 1);
    this.render();
    this.commit();
    this.focusCell(Math.min(row + 1, this.table.rows.length), 0);
  }

  private addColumn(): void {
    this.table.header.push("");
    this.table.align.push(null);
    for (const row of this.table.rows) row.push("");
    this.render();
    this.commit();
    this.focusCell(0, this.table.header.length - 1);
  }

  private deleteColumn(col: number): void {
    if (this.table.header.length <= 1) return; // keep at least one column
    this.table.header.splice(col, 1);
    this.table.align.splice(col, 1);
    for (const row of this.table.rows) row.splice(col, 1);
    this.render();
    this.commit();
    this.focusCell(0, Math.min(col, this.table.header.length - 1));
  }

  private cycleAlign(col: number): void {
    const idx = ALIGN_CYCLE.indexOf(this.table.align[col]);
    this.table.align[col] = ALIGN_CYCLE[(idx + 1) % ALIGN_CYCLE.length];
    this.render();
    this.commit();
    const btns = this.root?.querySelectorAll<HTMLElement>(".cm-table-align-btn");
    btns?.[col]?.focus();
  }

  // --- DOM → document --------------------------------------------------------

  /**
   * Serializes the model and writes it over the table's `[from, to)` range in
   * a single dispatch.
   *
   * The range is derived from the DOM at commit time rather than cached in
   * the widget: `view.posAtDOM(this.root)` returns the document offset of
   * this block widget's replaced range, and CM6 keeps that mapped through
   * every edit above the table. Caching `from`/`to` in the constructor was
   * unsound because only the *first* widget instance ever owns DOM (and all
   * the cell listeners close over it), while `computeTables` allocates a
   * fresh instance per recompute — so the live widget's cached coordinates
   * went stale and `commit()` overwrote the wrong slice of the document.
   *
   * `this.raw` is still updated *before* dispatching so the recompute this
   * triggers finds an equal widget (`eq`) and reuses this DOM — and its
   * focus. A no-op change (serialized text unchanged) is skipped so blurring
   * an untouched cell doesn't churn the document.
   */
  private commit(): void {
    const view = this.view;
    const root = this.root;
    if (!view || !root) return;
    const raw = serializeTable(this.table);
    if (raw === this.raw) return;
    const from = view.posAtDOM(root);
    const to = from + this.raw.length;
    this.raw = raw;
    view.dispatch({ changes: { from, to, insert: raw } });
  }
}

/**
 * Renders `![[target]]` embeds inline while editing (Live Preview). Image /
 * audio / video render as inline media; `.md` note transclusions reuse
 * `MarkdownRenderer.renderNoteEmbed()` (src/renderer/markdown/render.ts) so
 * the transcluded content — including nested embeds, links, and callouts —
 * is produced by the same code path as Reading view, not a parallel one.
 *
 * `#^blockid` embeds are out of scope: Reading view doesn't support them
 * either (only `#Heading` subpaths), so there's nothing to match here.
 */
class EmbedWidget extends WidgetType {
  private canvasView: CanvasView | null = null;
  private destroyed = false;

  constructor(
    private target: string,
    private param: string,
    private sourcePath: string,
    private app: App,
    private block: boolean
  ) {
    super();
  }

  eq(other: EmbedWidget): boolean {
    return (
      other.target === this.target &&
      other.param === this.param &&
      other.sourcePath === this.sourcePath &&
      other.block === this.block
    );
  }

  ignoreEvent(): boolean {
    // The widget wires up its own click handling (links inside a
    // transcluded note, audio/video controls) — let those events through
    // rather than have CM6 try to place the cursor inside the widget.
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement(this.block ? "div" : "span");
    root.className = "cm-embed-widget";
    if (this.block) root.classList.add("cm-embed-block");

    const resolved = resolveEmbed(this.target, this.sourcePath, this.app);

    if (resolved.kind === "unresolved") {
      root.classList.add("internal-embed", "is-unresolved");
      root.textContent = `Unresolved embed: ${this.target}`;
      return root;
    }

    const file = resolved.file!;

    if (resolved.kind === "canvas") {
      root.classList.add("canvas-embed-widget");
      if (this.sourcePath === file.path) {
        root.classList.add("canvas-embed-cycle");
        root.textContent = `Recursive Canvas embed: ${file.basename}`;
        return root;
      }
      const canvas = new CanvasView(this.app);
      this.canvasView = canvas;
      canvas.markEmbedded();
      canvas.onOpen();
      root.appendChild(canvas.containerEl);
      void canvas.setFile(file).then(() => {
        if (this.destroyed) {
          canvas.onClose();
          return;
        }
        view.requestMeasure();
      }).catch(() => {
        if (this.destroyed) return;
        canvas.onClose();
        if (this.canvasView === canvas) this.canvasView = null;
        root.replaceChildren();
        root.classList.add("is-unresolved");
        root.textContent = `Unable to load Canvas: ${file.basename}`;
        view.requestMeasure();
      });
      return root;
    }

    if (resolved.kind === "image") {
      const img = document.createElement("img");
      img.className = "internal-embed";
      img.alt = file.name;
      const { width, height } = parseEmbedDims(this.param);
      if (width) img.width = Number(width);
      if (height) img.height = Number(height);
      root.appendChild(img);
      loadEmbedBlobUrl(this.app, file).then((url) => {
        img.src = url;
        view.requestMeasure();
      });
      return root;
    }

    if (resolved.kind === "audio") {
      const audio = document.createElement("audio");
      audio.className = "internal-embed";
      audio.controls = true;
      root.appendChild(audio);
      loadEmbedBlobUrl(this.app, file).then((url) => (audio.src = url));
      return root;
    }

    if (resolved.kind === "video") {
      const video = document.createElement("video");
      video.className = "internal-embed";
      video.controls = true;
      root.appendChild(video);
      loadEmbedBlobUrl(this.app, file).then((url) => (video.src = url));
      return root;
    }

    if (resolved.kind === "note") {
      root.classList.add("markdown-embed");
      const title = document.createElement("div");
      title.className = "markdown-embed-title";
      title.textContent = file.basename;
      const content = document.createElement("div");
      content.className = "markdown-embed-content";
      content.textContent = "Loading…";
      root.appendChild(title);
      root.appendChild(content);
      this.app.markdownRenderer
        .renderNoteEmbed(file, resolved.subpath, this.sourcePath, content)
        .then(() => view.requestMeasure());
      return root;
    }

    // "other": resolved file with an extension Geode doesn't preview —
    // link out, matching Reading view's renderEmbed() fallback.
    const link = document.createElement("a");
    link.className = "internal-link";
    link.textContent = this.target;
    link.href = "#";
    link.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.app.openLink(this.target, this.sourcePath, e.metaKey || e.ctrlKey);
    });
    root.appendChild(link);
    return root;
  }

  destroy(_dom: HTMLElement): void {
    this.destroyed = true;
    this.canvasView?.onClose();
    this.canvasView = null;
  }
}

// --- Live preview extension -------------------------------------------------

export function livePreview(app: App, getPath: () => string): Extension {
  const hide = Decoration.replace({});

  const frontmatterField = StateField.define<DecorationSet>({
    create(state) {
      return computeFrontmatter(state.doc.sliceString(0, Math.min(state.doc.length, FM_SCAN)));
    },
    update(value, tr) {
      if (!tr.docChanged) return value;
      return computeFrontmatter(
        tr.state.doc.sliceString(0, Math.min(tr.state.doc.length, FM_SCAN))
      );
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  function computeFrontmatter(prefix: string): DecorationSet {
    const fm = frontmatterRange(prefix);
    if (!fm) return Decoration.none;
    return Decoration.set([
      Decoration.replace({ widget: new PropertiesWidget(fm.yaml, app), block: true }).range(
        0,
        fm.end
      ),
    ]);
  }

  // Pipe tables are block-level and can span many lines, so — like
  // frontmatter above — their decorations must come from a StateField, not
  // the ViewPlugin below (CM6 throws "Block decorations may not be
  // specified via plugins" for `block: true` decorations from a plugin).
  // Table nodes come from CodeMirror's Lezer GFM grammar (already parses
  // pipe tables into `Table` syntax-tree nodes), so detection is free; only
  // parsing the matched text into cell data (./table.ts) is bespoke.
  const tableField = StateField.define<DecorationSet>({
    create(state) {
      return computeTables(state);
    },
    update(value, tr) {
      // Tables are always rendered (the widget edits in place), so — unlike
      // the inline decorations below — the decoration set never depends on the
      // selection. It does depend on two things, though: the document *and*
      // the syntax tree. CodeMirror only parses `Work.InitViewport` (3000)
      // chars synchronously when the state is created; `ParseWorker` extends
      // the tree afterwards during idle callbacks and publishes each new tree
      // through a transaction with **no** document change. Recomputing on
      // `docChanged` alone therefore discarded every late-parsed table
      // forever — a table past ~3400 chars never rendered until something
      // else forced a fresh `create()` (e.g. toggling source mode). Comparing
      // tree identity is the same thing CM's own `TreeHighlighter.update`
      // does, and `syntaxTree()` returns the immutable snapshot that
      // `computeTables` reads, so guard and consumer stay coupled.
      if (!tr.docChanged && syntaxTree(tr.state) === syntaxTree(tr.startState)) return value;
      return computeTables(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  function computeTables(state: EditorState): DecorationSet {
    const doc = state.doc;
    const decos: Range<Decoration>[] = [];
    syntaxTree(state).iterate({
      enter(node) {
        if (node.name !== "Table") return;
        // Trim any trailing newline/whitespace Lezer folds into the Table
        // node so the replaced range covers exactly the table's text — the
        // widget writes serialized output (no trailing newline) back over
        // this same range, and eating the following blank line/newline would
        // merge the table into the next block.
        const nodeFrom = node.from;
        const rawFull = doc.sliceString(nodeFrom, Math.min(node.to, doc.length));
        const trimmed = rawFull.replace(/\s+$/, "");
        const to = nodeFrom + trimmed.length;
        const table = parseTable(trimmed);
        if (!table) return;
        // Always decorate (no cursor check): the block is atomic (see the
        // atomicRanges provider below), so the cursor never lands in the raw
        // markdown — editing goes through the widget's cell inputs instead.
        decos.push(
          Decoration.replace({
            widget: new TableWidget(trimmed, table),
            block: true,
          }).range(nodeFrom, to)
        );
      },
    });
    return Decoration.set(decos, true);
  }

  function buildInline(view: EditorView): DecorationSet {
    const decos: Range<Decoration>[] = [];
    const doc = view.state.doc;
    const sourcePath = getPath();
    const active = new Set<number>();
    for (const r of view.state.selection.ranges) {
      const from = doc.lineAt(r.from).number;
      const to = doc.lineAt(r.to).number;
      for (let i = from; i <= to; i++) active.add(i);
    }
    const fm = frontmatterRange(doc.sliceString(0, Math.min(doc.length, FM_SCAN)));
    const fmEnd = fm?.end ?? 0;
    const isActive = (pos: number) => active.has(doc.lineAt(pos).number);

    const listMarks: { line: number; from: number; to: number }[] = [];
    const taskLines = new Set<number>();
    // Lines belonging to a callout blockquote (`> [!type] Title`), keyed by
    // 1-based line number — populated by the "Blockquote" case below and
    // consumed by "QuoteMark" to tint the background and, on the header
    // line, swap the `[!type]` marker for an icon.
    const calloutLines = new Map<number, { meta: CalloutMeta; isHeader: boolean }>();

    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from,
        to,
        enter(node) {
          if (node.from < fmEnd) return;
          switch (node.name) {
            case "HeaderMark": {
              if (!node.node.parent?.name.startsWith("ATXHeading")) break;
              if (isActive(node.from)) break;
              const after = doc.sliceString(node.to, node.to + 1);
              decos.push(hide.range(node.from, after === " " ? node.to + 1 : node.to));
              break;
            }
            case "EmphasisMark":
            case "CodeMark":
            case "StrikethroughMark": {
              if (!isActive(node.from)) decos.push(hide.range(node.from, node.to));
              break;
            }
            case "Blockquote": {
              // Only the outermost `> ` prefix is stripped here (nested
              // callouts are out of scope), matching the marker Reading
              // view's transformCallouts() looks for.
              const startLine = doc.lineAt(node.from);
              if (startLine.from < fmEnd) break;
              const prefix = startLine.text.match(/^ {0,3}>\s?/);
              if (!prefix) break;
              const header = parseCalloutHeader(startLine.text.slice(prefix[0].length));
              if (!header) break;
              const meta = calloutMeta(header.type);
              const endLine = doc.lineAt(Math.min(node.to, doc.length));
              for (let ln = startLine.number; ln <= endLine.number; ln++) {
                calloutLines.set(ln, { meta, isHeader: ln === startLine.number });
              }
              break;
            }
            case "QuoteMark": {
              const line = doc.lineAt(node.from);
              const callout = calloutLines.get(line.number);
              let cls = "cm-live-quote";
              if (callout) {
                cls += ` cm-callout callout-${callout.meta.cssClass}`;
                if (callout.isHeader) cls += " cm-callout-title";
              }
              decos.push(Decoration.line({ class: cls }).range(line.from));
              const after = doc.sliceString(node.to, node.to + 1);
              const markerEnd = after === " " ? node.to + 1 : node.to;
              if (!isActive(node.from)) {
                decos.push(hide.range(node.from, markerEnd));
                if (callout?.isHeader) {
                  const markerLen = calloutMarkerLength(doc.sliceString(markerEnd, line.to));
                  if (markerLen !== null) {
                    decos.push(
                      Decoration.replace({ widget: new CalloutIconWidget(callout.meta.icon) }).range(
                        markerEnd,
                        markerEnd + markerLen
                      )
                    );
                  }
                }
              }
              break;
            }
            case "ListMark": {
              listMarks.push({ line: doc.lineAt(node.from).number, from: node.from, to: node.to });
              break;
            }
            case "TaskMarker": {
              const lineNo = doc.lineAt(node.from).number;
              taskLines.add(lineNo);
              if (!isActive(node.from)) {
                const checked = doc.sliceString(node.from, node.to).toLowerCase() !== "[ ]";
                decos.push(
                  Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(
                    node.from,
                    node.to
                  )
                );
              }
              break;
            }
            case "Link": {
              if (isActive(node.from)) break;
              const marks = node.node.getChildren("LinkMark");
              const url = node.node.getChild("URL");
              if (marks.length < 2 || !url) break;
              const href = doc.sliceString(url.from, url.to);
              const labelFrom = marks[0].to;
              const labelTo = marks[1].from;
              if (labelTo > labelFrom) {
                decos.push(
                  Decoration.mark({
                    class: "cm-live-extlink",
                    attributes: { "data-href": href },
                  }).range(labelFrom, labelTo)
                );
              }
              for (const mark of marks) decos.push(hide.range(mark.from, mark.to));
              decos.push(hide.range(url.from, url.to));
              break;
            }
            case "FencedCode": {
              const first = doc.lineAt(node.from).number;
              const last = doc.lineAt(Math.min(node.to, doc.length)).number;
              for (let i = first; i <= last; i++) {
                decos.push(Decoration.line({ class: "cm-live-codeblock" }).range(doc.line(i).from));
              }
              break;
            }
            case "HorizontalRule": {
              if (!isActive(node.from)) {
                decos.push(
                  Decoration.replace({ widget: new HRWidget() }).range(node.from, node.to)
                );
              }
              break;
            }
          }
        },
      });

      // Regex passes for syntax lezer doesn't model: wikilinks and highlights.
      const firstLine = doc.lineAt(from).number;
      const lastLine = doc.lineAt(to).number;
      for (let lineNo = firstLine; lineNo <= lastLine; lineNo++) {
        if (active.has(lineNo)) continue;
        const line = doc.line(lineNo);
        if (line.from < fmEnd) continue;
        const text = line.text;

        for (const m of text.matchAll(/(!?)\[\[([^\[\]\n]+)\]\]/g)) {
          const start = line.from + m.index!;
          const inner = m[2];
          const pipe = inner.indexOf("|");
          const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();

          if (m[1] === "!") {
            // Embed: render inline (image/audio/video) or as a block widget
            // (a `.md` note transclusion that occupies its whole line) —
            // matching Reading view's rendering via a shared resolver.
            const param = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
            const end = start + m[0].length;
            const resolved = resolveEmbed(target, sourcePath, app);
            const wholeLine = text.trim() === m[0];
            // Note: CM6 only allows `block: true` decorations from a
            // StateField, not a ViewPlugin (this decoration set is built by
            // the inlinePlugin ViewPlugin below) — using block:true here
            // throws "Block decorations may not be specified via plugins".
            // Instead, a whole-line note embed gets a non-block replace
            // decoration spanning the full line, with CSS (.cm-embed-block)
            // giving it block layout — the same technique HRWidget already
            // uses for full-line widgets in this file.
            const isBlock = (resolved.kind === "note" || resolved.kind === "canvas") && wholeLine;
            const widget = new EmbedWidget(target, param, sourcePath, app, isBlock);
            decos.push(
              Decoration.replace({ widget }).range(isBlock ? line.from : start, isBlock ? line.to : end)
            );
            continue;
          }

          const innerStart = start + 2;
          const displayFrom = pipe === -1 ? innerStart : innerStart + pipe + 1;
          const displayTo = start + 2 + inner.length;
          decos.push(hide.range(start, displayFrom));
          if (displayTo > displayFrom) {
            decos.push(
              Decoration.mark({
                class: "cm-live-wikilink",
                attributes: { "data-href": target },
              }).range(displayFrom, displayTo)
            );
          }
          decos.push(hide.range(displayTo, start + m[0].length));
        }

        for (const m of text.matchAll(/==([^=\n]+?)==/g)) {
          const start = line.from + m.index!;
          decos.push(hide.range(start, start + 2));
          decos.push(
            Decoration.mark({ class: "cm-live-highlight" }).range(
              start + 2,
              start + m[0].length - 2
            )
          );
          decos.push(hide.range(start + m[0].length - 2, start + m[0].length));
        }
      }
    }

    // Hide the "- " bullet on task lines so only the checkbox shows.
    for (const mark of listMarks) {
      if (taskLines.has(mark.line) && !active.has(mark.line)) {
        const after = doc.sliceString(mark.to, mark.to + 1);
        decos.push(hide.range(mark.from, after === " " ? mark.to + 1 : mark.to));
      }
    }

    return Decoration.set(decos, true);
  }

  const inlinePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildInline(view);
      }

      update(update: ViewUpdate) {
        // `buildInline` reads the syntax tree over `view.visibleRanges`, so —
        // like `tableField` above — it also has to rebuild when the tree
        // advances without the document changing (ParseWorker publishing a
        // longer tree from an idle callback). Without this, scrolling fast
        // into not-yet-parsed territory leaves `#`/`**`/etc. marks unhidden
        // until the next keystroke.
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState)
        ) {
          this.decorations = buildInline(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );

  const clickHandler = EditorView.domEventHandlers({
    mousedown(e, _view) {
      const target = e.target as HTMLElement;
      const wikilink = target.closest(".cm-live-wikilink") as HTMLElement | null;
      if (wikilink?.dataset.href) {
        e.preventDefault();
        app.openLink(wikilink.dataset.href, getPath(), e.metaKey || e.ctrlKey);
        return true;
      }
      const extlink = target.closest(".cm-live-extlink") as HTMLElement | null;
      if (extlink?.dataset.href) {
        e.preventDefault();
        app.openExternalLink(extlink.dataset.href);
        return true;
      }
      return false;
    },
  });

  return [
    frontmatterField,
    tableField,
    EditorView.atomicRanges.of(
      (view) => view.state.field(frontmatterField, false) ?? RangeSet.empty
    ),
    // Tables are always-rendered block widgets edited via their own cell
    // inputs; make the block atomic so cursor motion skips over it instead of
    // landing on the hidden raw markdown (mirrors frontmatter above).
    EditorView.atomicRanges.of((view) => view.state.field(tableField, false) ?? RangeSet.empty),
    inlinePlugin,
    clickHandler,
  ];
}
