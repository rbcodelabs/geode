import type { MarkdownConfig } from "@lezer/markdown";

/**
 * A geode comment marker is storage metadata, not Markdown. But its bytes start
 * with `<!--`, which is CommonMark's HTML-block start condition 2 — so when a
 * marker lands on the first content position of a line (the first word of a
 * paragraph, list item, or setext heading), Lezer swallows the whole line as an
 * HTML/comment block. Live Preview then never fires its `ListMark`/`TaskMarker`
 * hiding and styles the anchored prose as a comment.
 *
 * Reading view is unaffected because `markdown/render.ts` strips markers from
 * the whole document before parsing; only the editor parses the raw bytes.
 *
 * This config installs a marker-skipping block parser ahead of every default
 * block parser. When a line's content begins with a valid marker it registers
 * the marker the way `Blockquote` registers `>` and moves the line's base past
 * it, then returns `false` so the real block parsers see the line as if the
 * marker were not there.
 *
 * Two mechanics are load-bearing and easy to get wrong:
 *
 * 1. `Line.moveBase` only moves `basePos`; it does not advance `pos`/`next`.
 *    Those have to be recomputed by hand or the parser loops forever.
 * 2. `moveBase` recomputes `baseIndent` by counting columns *through* the
 *    skipped text. A marker is ~70+ characters, so letting it count would make
 *    every commented line look deeply indented and match `IndentedCode`. The
 *    indent in effect at the marker's start is therefore restored afterwards —
 *    a marker occupies no columns as far as block structure is concerned.
 */

const OPEN_AT = /^<!-- geode-comment:v1 id="[^"]+" data="[^"]*" -->/;
const CLOSE_AT = /^<!-- geode-comment-end:[^\s<>]+ -->/;

export const GEODE_COMMENT_MARKER_NODE = "GeodeCommentMarker";

export const geodeCommentMarkerSyntax: MarkdownConfig = {
  defineNodes: [{ name: GEODE_COMMENT_MARKER_NODE }],
  parseBlock: [{
    name: GEODE_COMMENT_MARKER_NODE,
    // Ahead of the first default block parser, so every one of them sees the
    // line with the marker already skipped.
    before: "LinkReference",
    parse(cx, line) {
      // A line can begin with a close marker immediately followed by an open
      // marker (two anchors that meet), so skip every marker at the head.
      for (;;) {
        const match = OPEN_AT.exec(line.text.slice(line.pos)) ?? CLOSE_AT.exec(line.text.slice(line.pos));
        if (!match) break;
        const indent = line.indent;
        const baseIndent = line.baseIndent;
        const from = cx.lineStart + line.pos;
        line.addMarker(cx.elt(GEODE_COMMENT_MARKER_NODE, from, from + match[0].length));
        line.moveBase(line.pos + match[0].length);
        // Restore the pre-marker indent (see note 2) and re-derive the cursor
        // fields `moveBase` leaves stale (see note 1).
        line.baseIndent = baseIndent;
        const next = line.skipSpace(line.basePos);
        line.pos = next;
        line.indent = indent;
        line.next = next === line.text.length ? -1 : line.text.charCodeAt(next);
      }
      // Never claim the block: `false` lets the real block parsers run against
      // the line with the marker already skipped.
      return false;
    },
  }],
};
