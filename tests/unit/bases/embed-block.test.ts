import { describe, expect, it } from "vitest";
import { findBaseBlocks, replaceNthBaseBlock } from "../../../src/renderer/bases/embed-block";

const NOTE = `# Notes

Some intro text.

\`\`\`base
views:
  - type: table
    name: Table
\`\`\`

Middle text.

\`\`\`base
views:
  - type: cards
    name: Cards
\`\`\`

End.
`;

describe("findBaseBlocks", () => {
  it("finds every base block with its YAML body in document order", () => {
    const blocks = findBaseBlocks(NOTE);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].yaml).toBe("views:\n  - type: table\n    name: Table");
    expect(blocks[1].yaml).toBe("views:\n  - type: cards\n    name: Cards");
  });

  it("ignores non-base fenced blocks", () => {
    const text = "```js\nconst x = 1;\n```\n\n```base\nviews: []\n```\n";
    const blocks = findBaseBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].yaml).toBe("views: []");
  });

  it("skips an unterminated base fence", () => {
    expect(findBaseBlocks("```base\nviews: []\n")).toEqual([]);
  });

  it("handles an indented base block (e.g. inside a list item)", () => {
    const text = "- item\n  ```base\n  views: []\n  ```\n";
    const blocks = findBaseBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].yaml).toBe("views: []");
  });
});

describe("replaceNthBaseBlock", () => {
  it("replaces only the targeted block's body, preserving surrounding text and the other block", () => {
    const out = replaceNthBaseBlock(NOTE, 1, "views:\n  - type: table\n    name: Renamed");
    const blocks = findBaseBlocks(out);
    expect(blocks[0].yaml).toBe("views:\n  - type: table\n    name: Table"); // untouched
    expect(blocks[1].yaml).toBe("views:\n  - type: table\n    name: Renamed");
    expect(out).toContain("Middle text.");
    expect(out).toContain("End.");
  });

  it("returns the text unchanged when the index is out of range", () => {
    expect(replaceNthBaseBlock(NOTE, 5, "x: 1")).toBe(NOTE);
  });

  it("round-trips through find after replacing an indented block", () => {
    const text = "- item\n  ```base\n  views: []\n  ```\n";
    const out = replaceNthBaseBlock(text, 0, "views:\n  - type: cards\n    name: C");
    expect(findBaseBlocks(out)[0].yaml).toBe("views:\n  - type: cards\n    name: C");
  });
});
