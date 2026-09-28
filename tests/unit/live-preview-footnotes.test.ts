import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { computeFootnoteDecorations } from "../../src/renderer/markdown/footnote-live";

function decos(doc: string, cursor = 0): { from: number; to: number; cls: string; widget: boolean }[] {
  const state = EditorState.create({ doc, selection: { anchor: cursor } });
  const set: DecorationSet = computeFootnoteDecorations(state);
  const out: { from: number; to: number; cls: string; widget: boolean }[] = [];
  set.between(0, doc.length, (from, to, value) => {
    const spec = value.spec as { class?: string; widget?: { className?: string } };
    out.push({ from, to, cls: spec.class ?? spec.widget?.className ?? "", widget: !!spec.widget });
  });
  return out;
}

const DOC = "Claim.[^1] end\n\nMore text\n\n[^1]: The source.\n";

describe("computeFootnoteDecorations", () => {
  it("replaces a defined reference with a superscript widget when the cursor is away", () => {
    const d = decos(DOC, DOC.length);
    const ref = d.find((x) => x.from === 6 && x.to === 10);
    expect(ref?.widget).toBe(true);
    expect(ref?.cls).toBe("cm-footnote-ref");
  });

  it("reveals the source when the cursor touches the reference", () => {
    expect(decos(DOC, 8).find((x) => x.from === 6 && x.to === 10)).toBeUndefined();
    expect(decos(DOC, 6).find((x) => x.from === 6 && x.to === 10)).toBeUndefined();
    expect(decos(DOC, 10).find((x) => x.from === 6 && x.to === 10)).toBeUndefined();
  });

  it("styles the definition line and swaps its label for a widget", () => {
    const d = decos(DOC, 0);
    const defStart = DOC.indexOf("[^1]:");
    expect(d.some((x) => x.from === defStart && x.cls === "cm-footnote-definition")).toBe(true);
    expect(d.some((x) => x.from === defStart && x.to === defStart + 5 && x.widget)).toBe(true);
  });

  it("keeps the definition label as source while the cursor is inside the definition", () => {
    const defStart = DOC.indexOf("[^1]:");
    const d = decos(DOC, defStart + 8);
    expect(d.some((x) => x.from === defStart && x.cls === "cm-footnote-definition")).toBe(true);
    expect(d.some((x) => x.from === defStart && x.to === defStart + 5 && x.widget)).toBe(false);
  });

  it("styles every line of a multi-line definition", () => {
    const doc = "a[^1]\n\n[^1]: first\n    second\n";
    const d = decos(doc, 0).filter((x) => x.cls === "cm-footnote-definition");
    expect(d.map((x) => x.from)).toEqual([doc.indexOf("[^1]:"), doc.indexOf("    second")]);
  });

  it("leaves a reference without a definition as literal text", () => {
    expect(decos("Dangling[^ghost] text", 20)).toEqual([]);
  });

  it("does not decorate footnote syntax inside code", () => {
    const doc = "`x[^1]`\n\n```\n[^1]: no\n```\n\n[^1]: yes\n";
    const d = decos(doc, doc.length);
    // only the real definition (outside the fence) is decorated; no ref widgets
    expect(d.filter((x) => x.cls === "cm-footnote-ref")).toEqual([]);
    expect(d.filter((x) => x.cls === "cm-footnote-definition").map((x) => x.from)).toEqual([
      doc.lastIndexOf("[^1]:"),
    ]);
  });

  it("replaces an inline footnote with a widget when the cursor is away", () => {
    const doc = "Hi^[inline note] there";
    const d = decos(doc, doc.length);
    expect(d.find((x) => x.from === 2 && x.to === 16)?.cls).toBe("cm-footnote-ref");
    expect(decos(doc, 5).find((x) => x.from === 2)).toBeUndefined();
  });
});
