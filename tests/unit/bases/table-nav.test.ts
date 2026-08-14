import { describe, expect, it } from "vitest";
import { cellsInSelection, moveCursor } from "../../../src/renderer/bases/table-nav";

describe("moveCursor", () => {
  const rowCount = 3;
  const colCount = 4;

  it("arrow keys move one step and clamp at grid edges (no wrap)", () => {
    expect(moveCursor({ row: 1, col: 1 }, "ArrowUp", rowCount, colCount)).toEqual({ row: 0, col: 1 });
    expect(moveCursor({ row: 0, col: 1 }, "ArrowUp", rowCount, colCount)).toEqual({ row: 0, col: 1 });
    expect(moveCursor({ row: 1, col: 1 }, "ArrowDown", rowCount, colCount)).toEqual({ row: 2, col: 1 });
    expect(moveCursor({ row: 2, col: 1 }, "ArrowDown", rowCount, colCount)).toEqual({ row: 2, col: 1 });
    expect(moveCursor({ row: 1, col: 0 }, "ArrowLeft", rowCount, colCount)).toEqual({ row: 1, col: 0 });
    expect(moveCursor({ row: 1, col: 3 }, "ArrowRight", rowCount, colCount)).toEqual({ row: 1, col: 3 });
  });

  it("Home/End jump to the first/last column of the current row", () => {
    expect(moveCursor({ row: 1, col: 2 }, "Home", rowCount, colCount)).toEqual({ row: 1, col: 0 });
    expect(moveCursor({ row: 1, col: 2 }, "End", rowCount, colCount)).toEqual({ row: 1, col: 3 });
  });

  it("Tab advances to the next column, wrapping to the next row's first column", () => {
    expect(moveCursor({ row: 0, col: 0 }, "Tab", rowCount, colCount)).toEqual({ row: 0, col: 1 });
    expect(moveCursor({ row: 0, col: 3 }, "Tab", rowCount, colCount)).toEqual({ row: 1, col: 0 });
    // At the very last cell, Tab has nowhere to go.
    expect(moveCursor({ row: 2, col: 3 }, "Tab", rowCount, colCount)).toEqual({ row: 2, col: 3 });
  });

  it("Shift+Tab reverses: previous column, wrapping to the previous row's last column", () => {
    expect(moveCursor({ row: 1, col: 1 }, "ShiftTab", rowCount, colCount)).toEqual({ row: 1, col: 0 });
    expect(moveCursor({ row: 1, col: 0 }, "ShiftTab", rowCount, colCount)).toEqual({ row: 0, col: 3 });
    expect(moveCursor({ row: 0, col: 0 }, "ShiftTab", rowCount, colCount)).toEqual({ row: 0, col: 0 });
  });

  it("is a no-op on an empty grid", () => {
    expect(moveCursor({ row: 0, col: 0 }, "ArrowDown", 0, 0)).toEqual({ row: 0, col: 0 });
  });
});

describe("cellsInSelection", () => {
  it("a cell selection is just itself", () => {
    expect(cellsInSelection({ type: "cell", pos: { row: 1, col: 2 } }, 3, 4)).toEqual([{ row: 1, col: 2 }]);
  });

  it("a row selection covers every column in that row", () => {
    expect(cellsInSelection({ type: "row", row: 1 }, 3, 3)).toEqual([
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
    ]);
  });

  it("a column selection covers every row in that column", () => {
    expect(cellsInSelection({ type: "column", col: 2 }, 2, 3)).toEqual([
      { row: 0, col: 2 },
      { row: 1, col: 2 },
    ]);
  });

  it("no selection covers no cells", () => {
    expect(cellsInSelection({ type: "none" }, 3, 3)).toEqual([]);
  });
});
