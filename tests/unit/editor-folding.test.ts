import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { foldEffect, foldedRanges } from "@codemirror/language";
import { foldingExtensions, foldRanges, foldCommand, restoreFolds, savedFolds, multipleSelectionExtensions } from "../../src/renderer/markdown/folding";
import { geodeCommentMarkerSyntax } from "../../src/renderer/comments/marker-syntax";

const enabled = { foldHeading: true, foldIndent: true };
function state(doc: string, settings = enabled) {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [geodeCommentMarkerSyntax] }), foldingExtensions(settings)] });
}
function ranges(doc: string, settings = enabled) { return foldRanges(state(doc, settings), settings); }

describe("Markdown folding", () => {
  it("does not fold YAML properties as a Setext heading with the production Markdown parser", () => {
    const doc = "---\nstatus: new\n---\n# Parent\nWorld map[^a]\n\n[^a]: First note\n# Next\nalpha\nbravo\n";
    const current = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [geodeCommentMarkerSyntax] }), foldingExtensions(enabled)] });
    expect(foldRanges(current, enabled).map(range => current.doc.lineAt(range.from).text)).toEqual(["# Parent", "# Next"]);
  });
  it("excludes YAML lists and code-looking values while retaining body Setext and list folds", () => {
    const current = state('---\nitems:\n  - first\n  - second\nexample: "```"\n---\nTitle\n=====\nbody\n- parent\n  - nested\n');
    expect(foldRanges(current, enabled).map(range => current.doc.lineAt(range.from).text)).toEqual(["Title", "- parent"]);
  });
  it("locates closed CRLF frontmatter in normalized CM text without hiding body headings", () => {
    const current = state("---\r\nstatus: new\r\n---\r\n# Body\r\ncontent\r\n");
    expect(foldRanges(current, enabled).map(range => current.doc.lineAt(range.from).text)).toEqual(["# Body"]);
  });
  it("keeps ordinary Markdown behavior for an unclosed leading delimiter", () => {
    const current = state("---\ntitle: text\n# Body\ncontent\n");
    expect(foldRanges(current, enabled).map(range => current.doc.lineAt(range.from).text)).toEqual(["# Body"]);
  });
  it("folds nested headings to the next equal or higher heading", () => {
    const doc = "# One\nbody\n## Child\nchild body\n# Two\nend";
    expect(ranges(doc)).toEqual([
      { from: 5, to: 30 }, { from: 19, to: 30 }, { from: 36, to: doc.length },
    ]);
  });
  it("recognizes setext headings and ignores heading-like text inside code", () => {
    const doc = "Title\n=====\nbody\n```\n# fake\n```\nNext\n====\nlast";
    expect(ranges(doc)).toEqual([{ from: 5, to: 31 }, { from: 36, to: doc.length }]);
  });
  it("folds indented ordered and task list children", () => {
    const doc = "1. parent\n   - [ ] child\n     - nested\n2. peer";
    expect(ranges(doc)).toEqual([{ from: 9, to: 38 }, { from: 24, to: 38 }]);
  });
  it("does not expose single-line headings or list items", () => {
    expect(ranges("# One\n# Two\n- leaf\n- other")).toEqual([{ from: 11, to: 26 }]);
    expect(ranges("- leaf\n- other")).toEqual([]);
  });
  it("honors independent heading and indent settings", () => {
    const doc = "# Title\n- parent\n  - child";
    expect(ranges(doc, { foldHeading: false, foldIndent: true })).toEqual([{ from: 16, to: 26 }]);
    expect(ranges(doc, { foldHeading: true, foldIndent: false })).toEqual([{ from: 7, to: 26 }]);
    expect(ranges(doc, { foldHeading: false, foldIndent: false })).toEqual([]);
  });
  it("fold more starts at the nearest enclosing section and fold less reverses it", () => {
    let current = state("# Parent\n## Child\nbody\n# Next");
    current = current.update({ selection: { anchor: 20 } }).state;
    const view = { get state() { return current; }, dispatch(spec: any) { current = current.update(spec).state; } };
    expect(foldCommand(view as any, "more", enabled)).toBe(true);
    expect(savedFolds(current).ranges).toEqual([{ from: 17, to: 22 }]);
    foldCommand(view as any, "more", enabled);
    expect(savedFolds(current).ranges).toHaveLength(2);
    foldCommand(view as any, "less", enabled);
    expect(savedFolds(current).ranges).toEqual([{ from: 17, to: 22 }]);
  });
  it("restores folds only against an unchanged document and validates ranges", () => {
    let current = state("# Title\nbody");
    current = current.update({ effects: foldEffect.of({ from: 7, to: 12 }) }).state;
    const saved = savedFolds(current);
    expect(restoreFolds(state("# Title\nbody"), saved)).toHaveLength(1);
    expect(restoreFolds(state("# Title\nchanged"), saved)).toEqual([]);
    expect(restoreFolds(state("# Title\nbody"), { ...saved, ranges: [{ from: -1, to: 999 }] })).toEqual([]);
  });
  it("refuses syntactically invalid persisted ranges even if in bounds", () => {
    const current = state("# Title\nbody");
    expect(restoreFolds(current, { ...savedFolds(current), ranges: [{ from: 1, to: 4 }] })).toEqual([]);
  });
  it("maps fold ranges when text before a heading changes", () => {
    let current = state("prefix\n# Title\nbody");
    current = current.update({ effects: foldEffect.of({ from: 14, to: 19 }) }).state;
    current = current.update({ changes: { from: 0, insert: "new " } }).state;
    expect(savedFolds(current).ranges).toEqual([{ from: 18, to: 23 }]);
    expect(foldedRanges(current).size).toBe(1);
  });
});

it("allows multiple replacement ranges and supports normal multi-edit transactions", () => {
  let current = EditorState.create({ doc: "abc\nabc", extensions: multipleSelectionExtensions() });
  current = current.update({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]) }).state;
  expect(current.selection.ranges).toHaveLength(2);
  current = current.update(current.replaceSelection("-")).state;
  expect(current.doc.toString()).toBe("-abc\n-abc");
});
