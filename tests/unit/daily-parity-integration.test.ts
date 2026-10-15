import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
import { foldCommand, foldingExtensions, multipleSelectionExtensions, savedFolds } from "../../src/renderer/markdown/folding";
import { mutateProperty } from "../../src/renderer/properties/property-source";
import { projectFootnotes } from "../../src/renderer/footnotes-pane";

const source = "---\nstatus: old\n---\n# Parent\nWorld map[^a]\n\n[^a]: First note\n# Next\nalpha\nbravo\n";
function fixture() {
  const settings = { foldHeading: true, foldIndent: true };
  let state = EditorState.create({ doc: source, extensions: [history(), markdown(), foldingExtensions(settings), multipleSelectionExtensions()] });
  const editor = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } };
  const view = Object.create(MarkdownView.prototype) as MarkdownView;
  Object.assign(view, { editor, mode: "source", vaultSwitching: false, conflictReadOnly: false });
  return { view, editor, settings };
}

describe("combined daily editing contracts", () => {
  it("keeps a folded live buffer and preceding body edit through property, link and footnote undo", async () => {
    const { view, editor, settings } = fixture();
    expect(foldCommand(editor as unknown as EditorView, "all", settings)).toBe(true);
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: "Dirty body\n" } });
    const dirty = view.getText();
    const property = mutateProperty(dirty, { kind: "set", key: "status", value: "new", expected: "old" });
    expect(property.ok).toBe(true);
    if (!property.ok) throw new Error(property.error);
    expect(view.applySourceEdit(dirty, property.from, property.to, property.insert)).toBe(true);
    expect(savedFolds(editor.state).ranges).toHaveLength(2);
    expect(undo(editor as unknown as EditorView)).toBe(true);
    expect(view.getText()).toBe(dirty);
    const from = dirty.indexOf("World map");
    expect(view.applySourceEdit(dirty, from, from + 9, "[[Atlas|World map]]")).toBe(true);
    expect(view.getText()).toContain("[[Atlas|World map]][^a]");
    expect(undo(editor as unknown as EditorView)).toBe(true);
    expect(view.getText()).toBe(dirty);
    const footnote = (await projectFootnotes(view.getText())).items.find(item => item.text === "First note");
    expect(footnote?.editable).toBe(true);
    expect(view.applySourceEdit(view.getText(), footnote!.editFrom, footnote!.editTo, "Changed note")).toBe(true);
    expect(view.getText()).toContain("[^a]: Changed note");
    expect(undo(editor as unknown as EditorView)).toBe(true);
    expect(view.getText()).toBe(dirty);
    expect(savedFolds(editor.state).ranges).toHaveLength(2);
  });

  it("formats every selection after a sidebar edit and undoes formatting without losing the property", () => {
    const { view, editor } = fixture();
    const property = mutateProperty(source, { kind: "set", key: "status", value: "new", expected: "old" });
    if (!property.ok) throw new Error(property.error);
    expect(view.applySourceEdit(source, property.from, property.to, property.insert)).toBe(true);
    const changed = view.getText();
    const first = changed.indexOf("alpha"), second = changed.indexOf("bravo");
    editor.dispatch({ selection: EditorSelection.create([EditorSelection.range(first, first + 5), EditorSelection.range(second + 5, second)], 1) });
    (view as unknown as { wrapSelection(target: typeof editor, marker: string): void }).wrapSelection(editor, "**");
    expect(view.getText()).toContain("**alpha**\n**bravo**");
    expect(editor.state.selection.ranges).toHaveLength(2);
    expect(undo(editor as unknown as EditorView)).toBe(true);
    expect(view.getText()).toBe(changed);
    expect(undo(editor as unknown as EditorView)).toBe(true);
    expect(view.getText()).toBe(source);
  });
});
