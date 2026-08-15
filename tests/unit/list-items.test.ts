import { describe, expect, it } from "vitest";
import { parseMetadata } from "../../src/renderer/metadata-cache";

/**
 * `listItems` is what obsidian-tasks reads to locate checklist items — without
 * it a ```tasks query renders "0 tasks" even when the vault is full of tasks.
 * It branches on `listItems === undefined` (skip file) and reads each item's
 * `position.start.line`, `task` (checkbox char, undefined for plain bullets),
 * and `parent` (parent line; negative for a top-level item).
 */

describe("parseMetadata listItems", () => {
  it("is undefined when the note has no list items", () => {
    expect(parseMetadata("# Title\n\nSome prose.\n").listItems).toBeUndefined();
  });

  it("captures open and done task status characters", () => {
    const items = parseMetadata("- [ ] open\n- [x] done\n- [/] partial\n").listItems!;
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.task)).toEqual([" ", "x", "/"]);
  });

  it("leaves task undefined for plain (non-checkbox) bullets", () => {
    const items = parseMetadata("- just a bullet\n* another\n+ third\n").listItems!;
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.task === undefined)).toBe(true);
  });

  it("records file-absolute line numbers (frontmatter offsets included)", () => {
    const items = parseMetadata("---\ntitle: x\n---\n\n- [ ] first\n- [ ] second\n").listItems!;
    // '---'(0) 'title'(1) '---'(2) ''(3) '- [ ] first'(4) '- [ ] second'(5)
    expect(items.map((i) => i.position.start.line)).toEqual([4, 5]);
  });

  it("resolves nesting: a sub-task's parent is its parent item's line; roots are negative", () => {
    const md = "- [ ] parent\n    - [ ] child\n    - [ ] child2\n- [ ] sibling\n";
    const items = parseMetadata(md).listItems!;
    // lines: parent=0, child=1, child2=2, sibling=3
    expect(items[0].parent).toBeLessThan(0); // root
    expect(items[1].parent).toBe(0); // child -> parent line 0
    expect(items[2].parent).toBe(0); // child2 -> parent line 0
    expect(items[3].parent).toBeLessThan(0); // sibling is a root again
  });

  it("supports ordered-list markers", () => {
    const items = parseMetadata("1. [ ] one\n2. [x] two\n3) plain\n").listItems!;
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.task)).toEqual([" ", "x", undefined]);
  });

  it("excludes list lines inside fenced code blocks", () => {
    const md = "- [ ] real\n\n```\n- [ ] fake in code\n```\n\n- [ ] real2\n";
    const items = parseMetadata(md).listItems!;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.position.start.line)).toEqual([0, 6]);
  });

  it("captures a trailing block id", () => {
    const items = parseMetadata("- [ ] do it ^task-42\n").listItems!;
    expect(items[0].id).toBe("task-42");
    expect(items[0].task).toBe(" ");
  });

  it("ends a list context on an intervening paragraph (nesting does not leak across it)", () => {
    const md = "- [ ] a\n\nParagraph breaks the list.\n\n    - [ ] b\n";
    const items = parseMetadata(md).listItems!;
    // 'b' is indented but the paragraph reset the stack, so it's a root, not a
    // child of 'a'.
    expect(items).toHaveLength(2);
    expect(items[1].parent).toBeLessThan(0);
  });
});

describe("parseMetadata sections", () => {
  // obsidian-tasks skips any list item whose line is not covered by a section,
  // so every list-item line MUST fall inside a section (getSection != null).
  const sectionForLine = (md: string, line: number) =>
    (parseMetadata(md).sections ?? []).find(
      (s) => s.position.start.line <= line && s.position.end.line >= line
    );

  it("is undefined for an empty document", () => {
    expect(parseMetadata("").sections).toBeUndefined();
  });

  it("covers every list item's line with a 'list' section (the tasks requirement)", () => {
    const md = "# H\n\n- [ ] one\n- [ ] two\n";
    expect(sectionForLine(md, 2)?.type).toBe("list");
    expect(sectionForLine(md, 3)?.type).toBe("list");
  });

  it("groups a contiguous list into one section and types headings/paragraphs", () => {
    const md = "# Title\n\nA paragraph.\n\n- a\n- b\n- c\n";
    const secs = parseMetadata(md).sections!;
    expect(secs.find((s) => s.type === "heading")).toBeTruthy();
    expect(secs.find((s) => s.type === "paragraph")).toBeTruthy();
    const list = secs.filter((s) => s.type === "list");
    expect(list).toHaveLength(1);
    expect(list[0].position.start.line).toBe(4);
    expect(list[0].position.end.line).toBe(6);
  });

  it("emits a 'yaml' section for frontmatter and a 'code' section for fences", () => {
    const md = "---\ntitle: x\n---\n\n```js\ncode\n```\n";
    const secs = parseMetadata(md).sections!;
    expect(secs.find((s) => s.type === "yaml")).toBeTruthy();
    expect(secs.find((s) => s.type === "code")).toBeTruthy();
  });
});
