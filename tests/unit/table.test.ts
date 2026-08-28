import { describe, expect, it } from "vitest";
import { parseTable, serializeTable, type ParsedTable } from "../../src/renderer/markdown/table";

describe("parseTable", () => {
  it("parses a simple header + delimiter + rows table", () => {
    const src = ["| Feature | Status |", "| --- | --- |", "| Wikilinks | ✅ |", "| Backlinks | ✅ |"].join(
      "\n"
    );
    expect(parseTable(src)).toEqual({
      align: [null, null],
      header: ["Feature", "Status"],
      rows: [
        ["Wikilinks", "✅"],
        ["Backlinks", "✅"],
      ],
    });
  });

  it("parses alignment markers: left, center, right, and unspecified", () => {
    const src = ["| A | B | C | D |", "| :-- | :-: | --: | --- |", "| 1 | 2 | 3 | 4 |"].join("\n");
    const table = parseTable(src);
    expect(table?.align).toEqual(["left", "center", "right", null]);
  });

  it("returns null when there is no delimiter row", () => {
    const src = "| Feature | Status |\n| Wikilinks | ✅ |";
    expect(parseTable(src)).toBeNull();
  });

  it("returns null when the delimiter row doesn't match dash/colon syntax", () => {
    const src = "| Feature | Status |\n| foo | bar |";
    expect(parseTable(src)).toBeNull();
  });

  it("returns null for a single line (no delimiter)", () => {
    expect(parseTable("| just a header |")).toBeNull();
  });

  it("returns null when the header line has no pipe", () => {
    expect(parseTable("not a table\n---")).toBeNull();
  });

  it("handles a table with a header and delimiter but no data rows", () => {
    const src = "| A | B |\n| --- | --- |";
    expect(parseTable(src)).toEqual({ align: [null, null], header: ["A", "B"], rows: [] });
  });

  it("pads short rows and truncates long rows to the header's column count", () => {
    const src = ["| A | B | C |", "| --- | --- | --- |", "| 1 | 2 |", "| x | y | z | extra |"].join("\n");
    const table = parseTable(src);
    expect(table?.rows).toEqual([
      ["1", "2", ""],
      ["x", "y", "z"],
    ]);
  });

  it("unescapes \\| inside a cell instead of treating it as a separator", () => {
    const src = "| A | B |\n| --- | --- |\n| a \\| b | c |";
    const table = parseTable(src);
    expect(table?.rows).toEqual([["a | b", "c"]]);
  });

  it("tolerates rows without leading/trailing pipes", () => {
    const src = "A | B\n--- | ---\n1 | 2";
    const table = parseTable(src);
    expect(table).toEqual({ align: [null, null], header: ["A", "B"], rows: [["1", "2"]] });
  });

  it("stops at the first blank line, ignoring trailing content", () => {
    const src = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| not | included |";
    const table = parseTable(src);
    expect(table?.rows).toEqual([["1", "2"]]);
  });

  it("ignores trailing blank lines in the source", () => {
    const src = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n";
    const table = parseTable(src);
    expect(table?.rows).toEqual([["1", "2"]]);
  });
});

describe("serializeTable", () => {
  it("serializes a simple table to GFM pipe syntax", () => {
    const table: ParsedTable = {
      align: [null, null],
      header: ["Feature", "Status"],
      rows: [
        ["Wikilinks", "✅"],
        ["Backlinks", "✅"],
      ],
    };
    expect(serializeTable(table)).toBe(
      ["| Feature | Status |", "| --- | --- |", "| Wikilinks | ✅ |", "| Backlinks | ✅ |"].join("\n")
    );
  });

  it("emits the correct delimiter cell for each alignment variant", () => {
    const table: ParsedTable = {
      align: ["left", "center", "right", null],
      header: ["A", "B", "C", "D"],
      rows: [["1", "2", "3", "4"]],
    };
    expect(serializeTable(table)).toBe(
      ["| A | B | C | D |", "| :--- | :---: | ---: | --- |", "| 1 | 2 | 3 | 4 |"].join("\n")
    );
  });

  it("escapes literal pipes in cell text as \\|", () => {
    const table: ParsedTable = {
      align: [null, null],
      header: ["A", "B"],
      rows: [["a | b", "c"]],
    };
    expect(serializeTable(table)).toBe(["| A | B |", "| --- | --- |", "| a \\| b | c |"].join("\n"));
  });

  it("round-trips through parseTable for every alignment variant", () => {
    const table: ParsedTable = {
      align: ["left", "center", "right", null],
      header: ["A", "B", "C", "D"],
      rows: [
        ["1", "2", "3", "4"],
        ["x", "y", "z", "w"],
      ],
    };
    expect(parseTable(serializeTable(table))).toEqual(table);
  });

  it("round-trips a table with escaped pipes and empty cells", () => {
    const table: ParsedTable = {
      align: [null, "center"],
      header: ["Key", "Value"],
      rows: [
        ["a | b", ""],
        ["", "c | d | e"],
      ],
    };
    expect(parseTable(serializeTable(table))).toEqual(table);
  });

  it("round-trips a header-only table (no data rows)", () => {
    const table: ParsedTable = { align: [null, "right"], header: ["A", "B"], rows: [] };
    expect(parseTable(serializeTable(table))).toEqual(table);
  });
});
