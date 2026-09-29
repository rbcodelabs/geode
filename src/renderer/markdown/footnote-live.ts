/**
 * Live Preview footnotes: `[^1]` and `^[inline]` become a superscript while
 * the cursor is elsewhere, and a definition line is styled with its `[^1]:`
 * label swapped for a number -- both revert to raw source while the cursor is
 * in (or touching) them, Obsidian's behavior.
 *
 * Decorations come from a StateField (the same reason as `./math-live`): the
 * spans are scanned from text by `./footnotes`, so a late syntax tree cannot
 * change the result. Clicking a superscript jumps to its definition; clicking
 * a definition's number jumps back to the first reference.
 */
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { FRONTMATTER_BLOCK_RE } from "../../wiki/constants";
import { scanFootnotes } from "./footnotes";

function frontmatterEnd(text: string): number {
  const m = FRONTMATTER_BLOCK_RE.exec(text.slice(0, 8192));
  return m ? m[0].length : 0;
}

function touchesSelection(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.to >= from && r.from <= to);
}

/** Moves the cursor to `pos` and scrolls it into view (which also reveals the source there). */
function jumpTo(dom: HTMLElement, pos: number): void {
  const view = EditorView.findFromDOM(dom);
  if (!view) return;
  const clamped = Math.min(pos, view.state.doc.length);
  view.dispatch({
    selection: { anchor: clamped },
    effects: EditorView.scrollIntoView(clamped, { y: "center" }),
  });
  view.focus();
}

function previewText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}

class FootnoteRefWidget extends WidgetType {
  readonly className = "cm-footnote-ref";

  constructor(
    readonly number: number,
    readonly preview: string,
    /** Where the definition starts, or null for an inline footnote. */
    readonly definitionFrom: number | null
  ) {
    super();
  }

  eq(other: FootnoteRefWidget): boolean {
    return (
      other.number === this.number &&
      other.preview === this.preview &&
      other.definitionFrom === this.definitionFrom
    );
  }

  /**
   * A footnote with a definition handles its own click (jump there). An
   * inline one has nowhere to jump, so CodeMirror gets the click and puts the
   * cursor beside it, which reveals the editable source.
   */
  ignoreEvent(): boolean {
    return this.definitionFrom !== null;
  }

  toDOM(): HTMLElement {
    const sup = document.createElement("sup");
    sup.className = this.className;
    sup.textContent = `[${this.number}]`;
    sup.title = this.preview;
    const target = this.definitionFrom;
    if (target !== null) {
      sup.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        jumpTo(sup, target);
      });
    }
    return sup;
  }
}

class FootnoteLabelWidget extends WidgetType {
  readonly className = "cm-footnote-label";

  constructor(
    readonly label: string,
    /** First reference to this footnote, or null when nothing references it. */
    readonly referenceFrom: number | null
  ) {
    super();
  }

  eq(other: FootnoteLabelWidget): boolean {
    return other.label === this.label && other.referenceFrom === this.referenceFrom;
  }

  ignoreEvent(): boolean {
    return this.referenceFrom !== null;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = `[${this.label}]:`;
    const target = this.referenceFrom;
    if (target !== null) {
      span.title = "Back to reference";
      span.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        jumpTo(span, target);
      });
    }
    return span;
  }
}

export function computeFootnoteDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const { references, definitions } = scanFootnotes(text, frontmatterEnd(text));
  if (references.length === 0 && definitions.length === 0) return Decoration.none;

  const definitionById = new Map(definitions.map((d) => [d.id, d]));
  const firstReference = new Map<number, number>();
  const decos: Range<Decoration>[] = [];

  for (const ref of references) {
    if (!firstReference.has(ref.number)) firstReference.set(ref.number, ref.from);
    if (touchesSelection(state, ref.from, ref.to)) continue;
    const definition = ref.kind === "ref" ? definitionById.get(ref.id) : undefined;
    const widget = new FootnoteRefWidget(
      ref.number,
      previewText(ref.kind === "inline" ? ref.text : (definition?.text ?? "")),
      definition ? definition.from : null
    );
    decos.push(Decoration.replace({ widget }).range(ref.from, ref.to));
  }

  for (const def of definitions) {
    const firstLine = state.doc.lineAt(def.from).number;
    const lastLine = state.doc.lineAt(def.to).number;
    for (let n = firstLine; n <= lastLine; n++) {
      decos.push(
        Decoration.line({ class: "cm-footnote-definition" }).range(state.doc.line(n).from)
      );
    }
    if (touchesSelection(state, def.from, def.to)) continue;
    const label = def.number !== null ? String(def.number) : def.id;
    decos.push(
      Decoration.replace({
        widget: new FootnoteLabelWidget(
          label,
          def.number !== null ? (firstReference.get(def.number) ?? null) : null
        ),
      }).range(def.from, def.labelTo)
    );
  }

  return Decoration.set(decos, true);
}

export const footnoteField: Extension = StateField.define<DecorationSet>({
  create: computeFootnoteDecorations,
  update(value, tr) {
    if (!tr.docChanged && tr.state.selection === tr.startState.selection) return value;
    return computeFootnoteDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});
