import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { computeMathDecorations } from "../../src/renderer/markdown/math-live";

interface Deco {
  from: number;
  to: number;
  block: boolean;
  source: string;
  display: boolean;
}

function decos(doc: string, cursor?: number | [number, number]): Deco[] {
  const selection =
    cursor === undefined
      ? undefined
      : Array.isArray(cursor)
        ? EditorSelection.single(cursor[0], cursor[1])
        : EditorSelection.single(cursor);
  const state = EditorState.create({ doc, selection });
  const out: Deco[] = [];
  const set = computeMathDecorations(state);
  const cursorIter = set.iter();
  while (cursorIter.value) {
    const spec = cursorIter.value.spec as {
      block?: boolean;
      widget: { source: string; display: boolean };
    };
    out.push({
      from: cursorIter.from,
      to: cursorIter.to,
      block: !!spec.block,
      source: spec.widget.source,
      display: spec.widget.display,
    });
    cursorIter.next();
  }
  return out;
}

describe("Live Preview math decorations", () => {
  it("replaces an inline formula with a widget when the cursor is elsewhere", () => {
    const doc = "hello $x^2$ world\n\nother line";
    const d = decos(doc, doc.length);
    expect(d).toEqual([{ from: 6, to: 11, block: false, source: "x^2", display: false }]);
  });

  it("shows the source when the cursor is inside the formula", () => {
    const doc = "hello $x^2$ world\n\nother";
    expect(decos(doc, 8)).toEqual([]);
  });

  it("shows the source when the cursor touches either delimiter", () => {
    const doc = "hello $x^2$ world\n\nother";
    expect(decos(doc, 6)).toEqual([]);
    expect(decos(doc, 11)).toEqual([]);
  });

  it("only reveals the formula the cursor is in, not its neighbours", () => {
    const doc = "$a$ and $b$";
    const d = decos(doc, 1);
    expect(d.map((x) => x.source)).toEqual(["b"]);
  });

  it("treats a selection overlapping the formula as touching it", () => {
    const doc = "hello $x^2$ world";
    expect(decos(doc, [3, 9])).toEqual([]);
  });

  it("renders a standalone $$ block as a block widget spanning whole lines", () => {
    const doc = "intro\n\n$$\n\\frac{a}{b}\n$$\n\noutro";
    const d = decos(doc, doc.length);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ block: true, display: true });
    expect(doc.slice(d[0].from, d[0].to)).toBe("$$\n\\frac{a}{b}\n$$");
  });

  it("reveals the whole block source when the cursor is on any of its lines", () => {
    const doc = "intro\n\n$$\n\\frac{a}{b}\n$$\n\noutro";
    const middle = doc.indexOf("frac") + 2;
    expect(decos(doc, middle)).toEqual([]);
  });

  it("renders a single-line $$x$$ on its own line as a block widget", () => {
    const doc = "intro\n\n$$x^2$$\n\noutro";
    const d = decos(doc, doc.length);
    expect(d[0]).toMatchObject({ block: true, display: true, source: "x^2" });
  });

  it("renders $$x$$ embedded in prose as an inline (non-block) display widget", () => {
    const doc = "see $$x^2$$ here\n\nend";
    const d = decos(doc, doc.length);
    expect(d[0]).toMatchObject({ block: false, display: true });
  });

  it("produces no decorations for unbalanced or escaped dollars", () => {
    expect(decos("costs $5 and \\$6 and $7", 0)).toEqual([]);
  });

  it("produces no decorations for math inside code spans or fenced blocks", () => {
    const doc = "`$a$`\n\n```\n$b$\n$$\nc\n$$\n```\n";
    expect(decos(doc, 0)).toEqual([]);
  });

  it("does not decorate dollar signs inside frontmatter", () => {
    const doc = "---\nprice: $5 and $x$\n---\n\nbody $y$\n";
    const d = decos(doc, doc.length);
    expect(d.map((x) => x.source)).toEqual(["y"]);
  });

  it("still produces a decoration for invalid LaTeX (the widget renders the error)", () => {
    const doc = "bad $\\frac{$ here\n\nend";
    const d = decos(doc, doc.length);
    expect(d).toHaveLength(1);
  });
});
