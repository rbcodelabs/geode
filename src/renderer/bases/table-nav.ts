/**
 * Pure keyboard-navigation/selection coordinate math for the Table view's
 * grid of cells — split out of `views/bases/table-view.ts` so the math is
 * unit-testable without a DOM. Rows/columns are addressed by plain 0-based
 * index; `views/bases/table-view.ts` owns mapping those to actual
 * `QueryRow`s and column paths.
 */

export interface GridPos {
  row: number;
  col: number;
}

export type NavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Tab" | "ShiftTab" | "Home" | "End";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Move the active cell from `pos` per `key`, clamped to the grid bounds.
 * `Tab`/`ShiftTab` wrap to the next/previous row (Table view's "Tab/Shift+Tab
 * cell navigation" per the spec); arrow keys don't wrap. `Home`/`End` jump to
 * the first/last column of the current row.
 */
export function moveCursor(pos: GridPos, key: NavKey, rowCount: number, colCount: number): GridPos {
  if (rowCount <= 0 || colCount <= 0) return pos;
  const maxRow = rowCount - 1;
  const maxCol = colCount - 1;

  switch (key) {
    case "ArrowUp":
      return { row: clamp(pos.row - 1, 0, maxRow), col: pos.col };
    case "ArrowDown":
      return { row: clamp(pos.row + 1, 0, maxRow), col: pos.col };
    case "ArrowLeft":
      return { row: pos.row, col: clamp(pos.col - 1, 0, maxCol) };
    case "ArrowRight":
      return { row: pos.row, col: clamp(pos.col + 1, 0, maxCol) };
    case "Home":
      return { row: pos.row, col: 0 };
    case "End":
      return { row: pos.row, col: maxCol };
    case "Tab": {
      if (pos.col < maxCol) return { row: pos.row, col: pos.col + 1 };
      if (pos.row < maxRow) return { row: pos.row + 1, col: 0 };
      return pos;
    }
    case "ShiftTab": {
      if (pos.col > 0) return { row: pos.row, col: pos.col - 1 };
      if (pos.row > 0) return { row: pos.row - 1, col: maxCol };
      return pos;
    }
  }
}

export type Selection =
  | { type: "cell"; pos: GridPos }
  | { type: "row"; row: number }
  | { type: "column"; col: number }
  | { type: "none" };

/** Every grid cell covered by a selection (Ctrl+Space/Shift+Space select a whole column/row; a plain cell selection is just itself). */
export function cellsInSelection(sel: Selection, rowCount: number, colCount: number): GridPos[] {
  switch (sel.type) {
    case "none":
      return [];
    case "cell":
      return [sel.pos];
    case "row":
      return Array.from({ length: colCount }, (_, col) => ({ row: sel.row, col }));
    case "column":
      return Array.from({ length: rowCount }, (_, row) => ({ row, col: sel.col }));
  }
}
