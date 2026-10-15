/**
 * Markdown footnotes: `[^id]` references, `[^id]: text` definitions and
 * `^[inline]` footnotes.
 *
 * One scanner serves both surfaces so they cannot disagree about what a
 * footnote is: Reading view rewrites the source through `renderFootnoteSource`
 * before marked runs, and Live Preview maps the same spans onto CodeMirror
 * decorations (`./footnote-live`).
 *
 * Rules (Obsidian's):
 *  - a reference only counts when a definition with that id exists; otherwise
 *    it is left as literal text;
 *  - nothing inside a code span or fenced block is a footnote;
 *  - numbers follow the order of first reference, inline footnotes included;
 *  - a definition runs until the first non-blank line that is not indented
 *    (4 spaces or a tab), so it can span several paragraphs.
 */

export interface FootnoteRefSpan {
  kind: "ref";
  id: string;
  number: number;
  /** 0 for the first reference to this footnote, then 1, 2... */
  occurrence: number;
  from: number;
  to: number;
}

export interface InlineFootnoteSpan {
  kind: "inline";
  number: number;
  occurrence: 0;
  /** The text between `^[` and `]`, unrendered. */
  text: string;
  from: number;
  to: number;
}

export type FootnoteReference = FootnoteRefSpan | InlineFootnoteSpan;

export interface FootnoteDefinitionSpan {
  id: string;
  /** Null when nothing references it. */
  number: number | null;
  /** Definition body with continuation indentation removed. */
  text: string;
  /** Start of `[^id]:`. */
  from: number;
  /** End of the `[^id]:` label (excludes the space after it). */
  labelTo: number;
  /** End of the last line belonging to the definition. */
  to: number;
}

export interface FootnoteScan {
  /** In document order. */
  references: FootnoteReference[];
  definitions: FootnoteDefinitionSpan[];
}

/** One entry of the Reading view footnotes section. */
export interface FootnoteItem {
  number: number;
  text: string;
  refCount: number;
}

import { maskMarkdownCode } from "./code-mask";

const DEFINITION_START_RE = /^( {0,3})\[\^([^\]\s]+)\]:/;
const REFERENCE_RE = /\[\^([^\]\s]+)\]|\^\[((?:[^\[\]\n]|\[[^\[\]\n]*\])+)\]/g;

/**
 * Finds every footnote in `text`. `start` skips a prefix (frontmatter).
 * Offsets in the result index into `text`.
 */
export function scanFootnotes(text: string, start = 0): FootnoteScan {
  const masked = maskMarkdownCode(text);

  // --- definitions -------------------------------------------------------
  const definitions: FootnoteDefinitionSpan[] = [];
  const definedIds = new Set<string>();
  const definitionStarts = new Set<number>();
  const lineStarts: number[] = [];
  const lines = text.split("\n");
  {
    let offset = 0;
    for (const line of lines) {
      lineStarts.push(offset);
      offset += line.length + 1;
    }
  }
  const maskedLines = masked.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lineStarts[i] < start) continue;
    const m = DEFINITION_START_RE.exec(maskedLines[i]);
    if (!m) continue;
    const from = lineStarts[i] + m[1].length;
    const labelTo = from + m[2].length + 4; // `[^` + id + `]:`
    const parts = [lines[i].slice(labelTo - lineStarts[i]).replace(/^[ \t]+/, "")];
    let last = i;
    let pendingBlanks = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") {
        pendingBlanks++;
        continue;
      }
      if (!/^( {4}|\t)/.test(line)) break;
      for (; pendingBlanks > 0; pendingBlanks--) parts.push("");
      parts.push(line.replace(/^( {4}|\t)/, ""));
      last = j;
    }
    const to = lineStarts[last] + lines[last].length;
    i = last;
    if (definedIds.has(m[2])) continue; // first definition wins
    definedIds.add(m[2]);
    definitionStarts.add(from);
    definitions.push({
      id: m[2],
      number: null,
      text: parts.join("\n").replace(/^\n+/, "").trimEnd(),
      from,
      labelTo,
      to,
    });
  }

  // --- references --------------------------------------------------------
  const references: FootnoteReference[] = [];
  const numbers = new Map<string, number>();
  const occurrences = new Map<string, number>();
  let next = 1;
  for (const m of masked.matchAll(REFERENCE_RE)) {
    const from = m.index!;
    if (from < start) continue;
    if (text[from - 1] === "\\") continue;
    // A reference inside a definition body would be numbered but never appear
    // in the text the reader follows back to; leave it literal.
    if (definitions.some((d) => from >= d.from && from < d.to)) continue;
    const to = from + m[0].length;
    if (m[1] !== undefined) {
      if (definitionStarts.has(from)) continue; // the label of a definition
      if (!definedIds.has(m[1])) continue; // undefined: stays literal
      let number = numbers.get(m[1]);
      if (number === undefined) {
        number = next++;
        numbers.set(m[1], number);
      }
      const occurrence = occurrences.get(m[1]) ?? 0;
      occurrences.set(m[1], occurrence + 1);
      references.push({ kind: "ref", id: m[1], number, occurrence, from, to });
    } else {
      references.push({
        kind: "inline",
        number: next++,
        occurrence: 0,
        text: text.slice(from + 2, to - 1),
        from,
        to,
      });
    }
  }
  for (const def of definitions) def.number = numbers.get(def.id) ?? null;
  return { references, definitions };
}

