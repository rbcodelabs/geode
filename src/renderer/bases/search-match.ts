/**
 * Client-side substring search over a table view's currently rendered rows
 * — the toolbar's Search box, per the spec: "search items using their
 * displayed properties". Pure so it's cheaply unit-testable independent of
 * `views/bases/table-view.ts`'s DOM.
 */

/** Case-insensitive substring match against any of a row's displayed cell strings. Empty/whitespace-only query matches everything. */
export function matchesSearch(displayedCells: string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return displayedCells.some((cell) => cell.toLowerCase().includes(q));
}
