import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { MarkdownView } from "../../src/renderer/views/markdown-view";

function view() {
  let state = EditorState.create({ doc: "World map", extensions: [history()] });
  const editor = { get state() { return state; }, dispatch(transaction: any) { state = state.update(transaction).state; } };
  const value = Object.create(MarkdownView.prototype) as MarkdownView;
  Object.assign(value, { editor, mode: "source", vaultSwitching: false, conflictReadOnly: false });
  return { value, editor };
}
describe("safe sidebar editor transaction", () => {
  it("isolates one conversion in undo history, preserving a preceding adjacent unsaved edit", () => {
    const { value, editor } = view();
    editor.dispatch({ changes: { from: 0, insert: "World map " } });
    expect(value.applySourceEdit(value.getText(), 0, 9, "[[Atlas|World map]]")).toBe(true);
    expect(undo(editor)).toBe(true);
    expect(value.getText()).toBe("World map World map");
  });
  it("refuses read-only, switching, reading and stale snapshots", () => {
    const { value } = view();
    expect(value.applySourceEdit("old", 0, 9, "replacement")).toBe(false);
    for (const flag of ["vaultSwitching", "conflictReadOnly"]) {
      Object.assign(value, { [flag]: true });
      expect(value.applySourceEdit(value.getText(), 0, 9, "replacement")).toBe(false);
      Object.assign(value, { [flag]: false });
    }
    value.mode = "reading"; expect(value.applySourceEdit(value.getText(), 0, 9, "replacement")).toBe(false);
    expect(value.getText()).toBe("World map");
  });
});
