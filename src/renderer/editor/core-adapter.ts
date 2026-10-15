import { EditorSelection, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { isolateHistory, undo, redo } from "@codemirror/commands";

// Private preparation module: no product acquisition or compatibility export.
export interface EditorPosition { line: number; ch: number }
export interface EditorSelectionOrCaret { anchor: EditorPosition; head?: EditorPosition }
export interface EditorSelectionRange { anchor: EditorPosition; head: EditorPosition }
export interface EditorCoreNative {
  readonly state: EditorState;
  dispatch(transaction: Transaction): void;
}
export interface EditorCoreHost<Native extends EditorCoreNative> {
  readonly native: Native;
  isCurrent(native: Native): boolean;
  isEditable(): boolean;
  focus(): void;
  blur(): void;
  hasFocus(): boolean;
}
type CursorSide = "from" | "to" | "anchor" | "head";
function integer(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new TypeError("Editor positions require finite integers.");
  return value;
}
function text(value: string): string {
  if (typeof value !== "string") throw new TypeError("Editor text must be a string.");
  return value;
}
function offset(state: EditorState, position: EditorPosition): number {
  if (!position || typeof position !== "object") throw new TypeError("Editor position requires line and ch.");
  const index = Math.max(0, Math.min(state.doc.lines - 1, integer(position.line)));
  const line = state.doc.line(index + 1);
  return line.from + Math.max(0, Math.min(line.length, integer(position.ch)));
}
function position(state: EditorState, value: number): EditorPosition {
  const bounded = Math.max(0, Math.min(state.doc.length, integer(value)));
  const line = state.doc.lineAt(bounded);
  return { line: line.number - 1, ch: bounded - line.from };
}
/** ADR0036 provisional policy; host lifetime, persistence and DOM focus are unwired. */
export class EditorCoreAdapter<Native extends EditorCoreNative> {
  private readonly native: Native;
  readonly dispatch: (...specs: TransactionSpec[]) => void;
  constructor(private readonly host: EditorCoreHost<Native>) {
    this.native = host.native;
    // Existing callers may capture dispatch; retain the native receiver and guard.
    this.dispatch = (...specs) => {
      this.writable();
      this.native.dispatch(this.native.state.update(...specs));
    };
  }
  private current(): EditorState {
    if (!this.host.isCurrent(this.native)) throw new Error("Editor is unavailable: its native owner has been retired.");
    return this.native.state;
  }
  private writable(): EditorState {
    const state = this.current();
    if (!this.host.isEditable()) throw new Error("Editor is not editable in the current owner state.");
    return state;
  }
  private mutate(state: EditorState, spec: TransactionSpec, origin?: string): void {
    if (origin !== undefined && typeof origin !== "string") throw new TypeError("Editor origin must be a string.");
    const annotations = [isolateHistory.of("full")];
    const transaction = state.update(spec, { annotations: origin === undefined ? annotations : [...annotations, Transaction.userEvent.of(origin)] });
    this.native.dispatch(transaction);
  }
  get cm(): Native { this.current(); return this.native; }
  get state(): EditorState { return this.current(); }
  getDoc(): this { this.current(); return this; }
  getValue(): string { return this.current().doc.toString(); }
  getLine(line: number): string {
    const state = this.current();
    return state.doc.line(Math.max(0, Math.min(state.doc.lines - 1, integer(line))) + 1).text;
  }
  lineCount(): number { return this.current().doc.lines; }
  lastLine(): number { return this.current().doc.lines - 1; }
  posToOffset(value: EditorPosition): number { return offset(this.current(), value); }
  offsetToPos(value: number): EditorPosition { return position(this.current(), value); }
  getRange(from: EditorPosition, to: EditorPosition): string {
    const state = this.current(), a = offset(state, from), b = offset(state, to);
    return state.doc.sliceString(Math.min(a, b), Math.max(a, b));
  }
  setValue(value: string): void {
    const state = this.writable();
    this.mutate(state, { changes: { from: 0, to: state.doc.length, insert: text(value) } });
  }
  setLine(line: number, value: string): void {
    const state = this.writable();
    const target = state.doc.line(Math.max(0, Math.min(state.doc.lines - 1, integer(line))) + 1);
    this.mutate(state, { changes: { from: target.from, to: target.to, insert: text(value) } });
  }
  replaceRange(value: string, from: EditorPosition, to?: EditorPosition, origin?: string): void {
    const state = this.writable(), a = offset(state, from), b = to === undefined ? a : offset(state, to);
    this.mutate(state, { changes: { from: Math.min(a, b), to: Math.max(a, b), insert: text(value) } }, origin);
  }
  getSelection(): string {
    const state = this.current(), main = state.selection.main;
    return state.doc.sliceString(main.from, main.to);
  }
  replaceSelection(value: string, origin?: string): void {
    const state = this.writable();
    this.mutate(state, state.replaceSelection(text(value)), origin);
  }
  somethingSelected(): boolean { return this.current().selection.ranges.some(range => !range.empty); }
  getCursor(side: CursorSide = "head"): EditorPosition {
    const state = this.current();
    if (!["from", "to", "anchor", "head"].includes(side)) throw new TypeError("Unsupported editor cursor side.");
    return position(state, state.selection.main[side]);
  }
  setCursor(value: EditorPosition | number, ch = 0): void {
    this.setSelection(typeof value === "number" ? { line: value, ch } : value);
  }
  listSelections(): EditorSelectionRange[] {
    const state = this.current();
    return state.selection.ranges.map(range => ({ anchor: position(state, range.anchor), head: position(state, range.head) }));
  }
  setSelection(anchor: EditorPosition, head?: EditorPosition): void { this.setSelections([{ anchor, head }]); }
  setSelections(ranges: readonly EditorSelectionOrCaret[], main = 0): void {
    const state = this.current();
    if (!Array.isArray(ranges) || !ranges.length || integer(main) < 0 || main >= ranges.length) throw new RangeError("Editor selections require a nonempty array and valid main index.");
    const selection = EditorSelection.create(ranges.map(range => {
      if (!range || typeof range !== "object") throw new TypeError("Editor selection requires an anchor.");
      const anchor = offset(state, range.anchor);
      return EditorSelection.range(anchor, range.head === undefined ? anchor : offset(state, range.head));
    }), main);
    this.native.dispatch(state.update({ selection }));
  }
  focus(): void { this.current(); this.host.focus(); }
  blur(): void { this.current(); this.host.blur(); }
  hasFocus(): boolean { this.current(); return this.host.hasFocus(); }
  undo(): void {
    const state = this.writable();
    undo({ state, dispatch: transaction => this.native.dispatch(transaction) });
  }
  redo(): void {
    const state = this.writable();
    redo({ state, dispatch: transaction => this.native.dispatch(transaction) });
  }
}
