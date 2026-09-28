/**
 * Live Preview math: swaps `$inline$` / `$$block$$` for a rendered widget
 * while the cursor is elsewhere and leaves the raw source editable while the
 * cursor is in (or touching) it — Obsidian's behavior.
 *
 * Decorations come from a StateField rather than the inline ViewPlugin because
 * block widgets, and any replacement crossing a line break, are rejected by
 * CodeMirror when they originate in a plugin. The delimiter rules and code
 * exclusion live in `./math`; this file only maps spans onto decorations.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { FRONTMATTER_BLOCK_RE } from "../../wiki/constants";
import { findMathSpans, renderMathHtml, type MathSpan } from "./math";
import { ensureMathStyles } from "./math-style";

export class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly display: boolean,
    /** Owns whole lines (`$$` on its own lines), so the widget is a block. */
    readonly block: boolean
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return (
      other.source === this.source && other.display === this.display && other.block === this.block
    );
  }

  /**
   * Let CodeMirror handle clicks: placing the cursor next to the widget is what
   * flips it back to editable source. A widget that swallowed events would
   * leave the formula permanently uneditable.
   */
  ignoreEvent(): boolean {
    return false;
  }

  toDOM(): HTMLElement {
    ensureMathStyles();
    // KaTeX output is synchronous, so unlike Mermaid there is no async
    // re-measure to schedule once the widget has its final height.
    const root = document.createElement(this.block ? "div" : "span");
    root.className = this.block ? "cm-math-widget cm-math-block" : "cm-math-widget cm-math-inline";
    root.innerHTML = renderMathHtml(this.source, this.display);
    return root;
  }
}

function frontmatterEnd(text: string): number {
  const m = FRONTMATTER_BLOCK_RE.exec(text.slice(0, 8192));
  return m ? m[0].length : 0;
}

function touchesSelection(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.to >= from && r.from <= to);
}

/** Whole-line extent when the span has only whitespace around it on its lines. */
function ownedLines(state: EditorState, span: MathSpan): { from: number; to: number } | null {
  const first = state.doc.lineAt(span.from);
  const last = state.doc.lineAt(span.to);
  const before = state.doc.sliceString(first.from, span.from);
  const after = state.doc.sliceString(span.to, last.to);
  if (before.trim() !== "" || after.trim() !== "") return null;
  return { from: first.from, to: last.to };
}

export function computeMathDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const decos: Range<Decoration>[] = [];
  for (const span of findMathSpans(text, frontmatterEnd(text))) {
    const lines = span.display ? ownedLines(state, span) : null;
    const from = lines?.from ?? span.from;
    const to = lines?.to ?? span.to;
    if (touchesSelection(state, from, to)) continue;
    decos.push(
      Decoration.replace({
        widget: new MathWidget(span.source, span.display, lines !== null),
        block: lines !== null,
      }).range(from, to)
    );
  }
  return Decoration.set(decos, true);
}

export const mathField: Extension = StateField.define<DecorationSet>({
  create: computeMathDecorations,
  update(value, tr) {
    // Depends on the document (spans) and the selection (which are revealed),
    // but not on the syntax tree — spans are scanned from text, so a late
    // ParseWorker tree cannot change the result.
    if (!tr.docChanged && tr.state.selection === tr.startState.selection) return value;
    return computeMathDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});
