import { RangeSetBuilder, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { parseCommentThreads } from "./model";

export const commentDecorations = StateField.define<DecorationSet>({
  create(state) { return build(state.doc.toString()); },
  update(value, transaction) { return transaction.docChanged ? build(transaction.newDoc.toString()) : value; },
  provide: (field) => EditorView.decorations.from(field),
});

export function commentInteractions(onActivate: (threadId: string) => void) {
  return EditorView.domEventHandlers({
    click(event, view) {
      const target = event.target as HTMLElement;
      const id = target.closest<HTMLElement>(".cm-comment-anchor")?.dataset.commentId;
      if (!id) return false;
      onActivate(id);
      return true;
    },
  });
}

function build(source: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];
  for (const thread of parseCommentThreads(source).threads) {
    ranges.push({ from: thread.openFrom, to: thread.openTo, decoration: Decoration.replace({}) });
    if (!thread.detached) ranges.push({
      from: thread.from,
      to: thread.to,
      decoration: Decoration.mark({ class: "cm-comment-anchor", attributes: { "data-comment-id": thread.id } }),
    });
    ranges.push({ from: thread.closeFrom, to: thread.closeTo, decoration: Decoration.replace({}) });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const range of ranges) builder.add(range.from, range.to, range.decoration);
  return builder.finish();
}
