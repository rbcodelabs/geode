import { EditorState, type Extension, type StateEffect } from "@codemirror/state";
import { codeFolding, ensureSyntaxTree, foldEffect, foldedRanges, syntaxTree, unfoldEffect } from "@codemirror/language";
import { EditorView, GutterMarker, gutter, rectangularSelection } from "@codemirror/view";
import { getFrontMatterInfo } from "../api/frontmatter";

export interface FoldingSettings { foldHeading: boolean; foldIndent: boolean }
export interface FoldRange { from: number; to: number }
export type FoldAction = "all" | "none" | "more" | "less";

/** Parser nodes keep fenced code, escaped markers and list indentation unambiguous. */
export function foldRanges(state: EditorState, settings: FoldingSettings): FoldRange[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  const frontmatterEnd = getFrontMatterInfo(state.doc.toString()).contentStart;
  const ranges: FoldRange[] = [];
  tree.iterate({ enter(node) {
    // Lezer can interpret YAML keys or lists as Markdown. Continue traversing
    // the document, but only expose folding candidates from the note body.
    if (node.from < frontmatterEnd) return;
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
    if (heading && settings.foldHeading) {
      let last = node.node;
      for (let next = last.nextSibling; next; next = next.nextSibling) {
        const nextHeading = /^(?:ATX|Setext)Heading([1-6])$/.exec(next.name);
        if (nextHeading && Number(nextHeading[1]) <= Number(heading[1])) break;
        last = next;
      }
      const from = state.doc.lineAt(node.from).to;
      if (last.to > from) ranges.push({ from, to: last.to });
    } else if (node.name === "ListItem" && settings.foldIndent) {
      const from = state.doc.lineAt(node.from).to;
      if (node.to > from) ranges.push({ from, to: node.to });
    }
  } });
  return ranges.sort((a, b) => a.from - b.from || b.to - a.to);
}

function currentFolds(state: EditorState): FoldRange[] {
  const ranges: FoldRange[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => { ranges.push({ from, to }); });
  return ranges;
}
function sameRange(a: FoldRange, b: FoldRange): boolean { return a.from === b.from && a.to === b.to; }

export function foldCommand(view: Pick<EditorView, "state" | "dispatch">, action: FoldAction, settings: FoldingSettings): boolean {
  const folded = currentFolds(view.state);
  if (action === "none") {
    if (!folded.length) return false;
    view.dispatch({ effects: folded.map(range => unfoldEffect.of(range)) });
    return true;
  }
  const available = foldRanges(view.state, settings);
  let ranges: FoldRange[];
  if (action === "all") {
    // Fold children too, preserving the outline when a parent is unfolded.
    ranges = available.filter(range => !folded.some(existing => sameRange(existing, range)));
  } else {
    const position = view.state.selection.main.head;
    const candidates = (action === "less" ? folded : available.filter(range => !folded.some(existing => sameRange(existing, range))))
      .filter(range => view.state.doc.lineAt(range.from).from <= position && position <= range.to)
      .sort((a, b) => action === "less" ? (b.to - b.from) - (a.to - a.from) : (a.to - a.from) - (b.to - b.from));
    ranges = candidates.slice(0, 1);
  }
  if (!ranges.length) return false;
  view.dispatch({ effects: ranges.map(range => action === "less" ? unfoldEffect.of(range) : foldEffect.of(range)) });
  return true;
}

class FoldMarker extends GutterMarker {
  constructor(readonly folded: boolean) { super(); }
  eq(other: FoldMarker): boolean { return this.folded === other.folded; }
  toDOM(): HTMLElement {
    const button = document.createElement("button");
    button.className = "geode-fold-toggle";
    button.type = "button";
    button.textContent = this.folded ? "›" : "⌄";
    button.setAttribute("aria-label", this.folded ? "Unfold section" : "Fold section");
    button.setAttribute("aria-expanded", String(!this.folded));
    return button;
  }
}
const openMarker = new FoldMarker(false), closedMarker = new FoldMarker(true);

export function foldingExtensions(settings: FoldingSettings): Extension {
  // One range scan per state, rather than one full parser walk per visible line.
  let previous: EditorState | null = null;
  let ranges: FoldRange[] = [];
  const forState = (state: EditorState) => {
    if (previous !== state) { previous = state; ranges = foldRanges(state, settings); }
    return ranges;
  };
  const rangeAt = (state: EditorState, position: number) =>
    forState(state).find(range => state.doc.lineAt(range.from).from === state.doc.lineAt(position).from);
  const foldedAt = (state: EditorState, position: number) =>
    currentFolds(state).find(range => state.doc.lineAt(range.from).from === state.doc.lineAt(position).from);
  return [codeFolding(), gutter({
    class: "geode-fold-gutter",
    lineMarker(view, line) {
      if (foldedAt(view.state, line.from)) return closedMarker;
      return rangeAt(view.state, line.from) ? openMarker : null;
    },
    lineMarkerChange: update => update.docChanged || update.transactions.some(transaction => transaction.effects.length > 0) || syntaxTree(update.startState) !== syntaxTree(update.state),
    domEventHandlers: { click(view, line, event) {
      const folded = foldedAt(view.state, line.from);
      const range = folded ?? rangeAt(view.state, line.from);
      if (!range) return false;
      event.preventDefault();
      view.dispatch({ effects: folded ? unfoldEffect.of(range) : foldEffect.of(range) });
      view.focus();
      return true;
    } },
  })];
}

export function multipleSelectionExtensions(): Extension {
  return [EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of(event => event.altKey && !event.shiftKey),
    rectangularSelection({ eventFilter: event => event.button === 1 || (event.button === 0 && event.altKey && event.shiftKey) }),
  ];
}

function fingerprint(state: EditorState): string {
  let first = 2166136261, second = 5381;
  for (const chunk of state.doc) {
    for (let index = 0; index < chunk.length; index++) {
      first = Math.imul(first ^ chunk.charCodeAt(index), 16777619);
      second = Math.imul(second, 33) ^ chunk.charCodeAt(index);
    }
  }
  return `${state.doc.length}:${first >>> 0}:${second >>> 0}`;
}
export function savedFolds(state: EditorState): { fingerprint: string; ranges: FoldRange[] } {
  return { fingerprint: fingerprint(state), ranges: currentFolds(state) };
}
export function restoreFolds(state: EditorState, saved: unknown): StateEffect<FoldRange>[] {
  if (!saved || typeof saved !== "object") return [];
  const record = saved as { fingerprint?: unknown; ranges?: unknown };
  if (record.fingerprint !== fingerprint(state) || !Array.isArray(record.ranges)) return [];
  const available = foldRanges(state, { foldHeading: true, foldIndent: true });
  return record.ranges.filter((range): range is FoldRange => range && typeof range === "object"
    && Number.isInteger(range.from) && Number.isInteger(range.to) && range.from >= 0 && range.to > range.from && range.to <= state.doc.length && available.some(candidate => sameRange(candidate, range)))
    .map(range => foldEffect.of(range));
}
