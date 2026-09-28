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

const blank = (m: string): string => m.replace(/[^\n]/g, " ");

/**
 * Same-length copy of `text` with code blanked out (newlines kept), so match
 * offsets index straight into the original. Fenced blocks (``` and ~~~) go
 * first so a backtick inside a fence cannot pair with one outside it.
 */
function maskCode(text: string): string {
  let masked = text.replace(
    /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm,
    blank
  );
  // CommonMark code span: a run of N backticks closed by a run of exactly N.
  // May not cross a blank line.
  masked = masked.replace(
    /(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?[^`]\1(?!`)/g,
    blank
  );
  return masked;
}

const DEFINITION_START_RE = /^( {0,3})\[\^([^\]\s]+)\]:/;
const REFERENCE_RE = /\[\^([^\]\s]+)\]|\^\[((?:[^\[\]\n]|\[[^\[\]\n]*\])+)\]/g;

/**
 * Finds every footnote in `text`. `start` skips a prefix (frontmatter).
 * Offsets in the result index into `text`.
 */
export function scanFootnotes(text: string, start = 0): FootnoteScan {
  const masked = maskCode(text);

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

/** DOM id of the n-th (0-based) reference to footnote `number` in Reading view. */
export function footnoteRefId(number: number, occurrence: number): string {
  return occurrence === 0 ? `fnref-${number}` : `fnref-${number}-${occurrence + 1}`;
}

/** DOM id of footnote `number`'s entry in the Reading view footnotes section. */
export function footnoteItemId(number: number): string {
  return `fn-${number}`;
}

/**
 * Reading view step one: swaps each footnote reference for a superscript link
 * and removes the definitions from the body. The definitions come back as
 * `items` (ordered by number) for the caller to render into a section after
 * marked has run -- raw HTML with markdown inside it does not survive marked.
 */
export function renderFootnoteSource(
  text: string,
  start = 0
): { src: string; items: FootnoteItem[] } {
  const { references, definitions } = scanFootnotes(text, start);
  if (references.length === 0 && definitions.length === 0) return { src: text, items: [] };

  const definitionText = new Map(definitions.map((d) => [d.id, d.text]));
  const byNumber = new Map<number, FootnoteItem>();
  const edits: { from: number; to: number; html: string }[] = [];

  for (const ref of references) {
    const item = byNumber.get(ref.number);
    if (item) item.refCount++;
    else {
      byNumber.set(ref.number, {
        number: ref.number,
        text: ref.kind === "inline" ? ref.text : (definitionText.get(ref.id) ?? ""),
        refCount: 1,
      });
    }
    edits.push({
      from: ref.from,
      to: ref.to,
      html:
        `<sup class="footnote-ref" id="${footnoteRefId(ref.number, ref.occurrence)}">` +
        `<a class="footnote-link" href="#${footnoteItemId(ref.number)}">[${ref.number}]</a></sup>`,
    });
  }
  // Every definition leaves the body, referenced or not (it has no place in
  // running text and would otherwise render as a stray `[^id]: ...` paragraph).
  for (const def of definitions) edits.push({ from: def.from, to: def.to, html: "" });

  edits.sort((a, b) => a.from - b.from);
  let src = "";
  let cursor = 0;
  for (const edit of edits) {
    if (edit.from < cursor) continue; // a reference inside a removed definition
    src += text.slice(cursor, edit.from) + edit.html;
    cursor = edit.to;
  }
  src += text.slice(cursor);

  return { src, items: [...byNumber.values()].sort((a, b) => a.number - b.number) };
}
