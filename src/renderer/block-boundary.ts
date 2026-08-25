import type { ListItemCache, SectionCache } from "./types";

/**
 * Where to hang a block id (`^id`) for a "Bookmark block under cursor" at
 * `cursorLine` (0-based), given the file's metadata sections and list items.
 *
 * - `{ kind: "line", line }` — append the id to line `line`.
 * - `{ kind: "refuse", reason }` — do not write; the cursor is inside a fenced
 *   code block or YAML frontmatter, where a trailing `^id` would corrupt the
 *   fence/frontmatter for the rest of the document.
 *
 * Pure (no DOM/CodeMirror), so it's unit-testable directly. Rules:
 * - Code / YAML section → refuse.
 * - List section → resolve the specific `listItems` entry containing the cursor
 *   line and target that item's own last line (so a `^id` on bullet 1 lands on
 *   bullet 1, not the section's last bullet).
 * - Any other section (paragraph, heading, …) → the section's end line (a
 *   multi-line paragraph is genuinely one block).
 * - No enclosing section → the cursor line itself.
 */
export type BlockBoundary =
  | { kind: "line"; line: number }
  | { kind: "refuse"; reason: string };

export function resolveBlockBoundary(
  cursorLine: number,
  sections: SectionCache[],
  listItems: ListItemCache[]
): BlockBoundary {
  const section = sections.find(
    (s) => s.position.start.line <= cursorLine && cursorLine <= s.position.end.line
  );
  if (!section) return { kind: "line", line: cursorLine };

  if (section.type === "code" || section.type === "yaml") {
    return {
      kind: "refuse",
      reason: "Can't bookmark a block inside a code or frontmatter block",
    };
  }

  if (section.type === "list") {
    const item = listItems.find(
      (li) => li.position.start.line <= cursorLine && cursorLine <= li.position.end.line
    );
    if (item) return { kind: "line", line: item.position.end.line };
    return { kind: "line", line: cursorLine };
  }

  return { kind: "line", line: section.position.end.line };
}
