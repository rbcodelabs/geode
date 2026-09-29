/**
 * LaTeX math for markdown: `$inline$` and `$$display$$`.
 *
 * This module is the single source of truth for *what counts as math*, shared
 * by both rendering paths so they cannot drift apart:
 *
 *  - Live Preview (`math-live.ts`) scans the document text with
 *    `findMathSpans` and swaps each span for a widget.
 *  - Reading view / transclusions / table cells (`math-marked.ts`) hand
 *    `matchMathAt` to marked's tokenizer hooks.
 *
 * The delimiter rules follow Obsidian (which follows Pandoc):
 *
 *  - `$...$` opens on a `$` not followed by whitespace, closes on a `$` not
 *    preceded by whitespace and not followed by a digit, and never spans
 *    lines. That is what keeps `$5 and $10` (currency) from becoming math.
 *  - `$$...$$` may span lines but never a blank line, so a stray unclosed
 *    `$$` cannot swallow the rest of the document.
 *  - `\$` is a literal dollar, including inside a formula.
 *  - Nothing inside a code span or fenced code block is math.
 *
 * Deliberately DOM-free (KaTeX's `renderToString` is pure) so all of it runs
 * under the node-environment unit suite.
 */
import katex from "katex";

export interface MathMatch {
  /** Offset just past the closing delimiter, relative to the scanned text. */
  end: number;
  /** LaTeX between the delimiters, exactly as written. */
  source: string;
  /** `$$...$$` (display) rather than `$...$` (inline). */
  display: boolean;
}

export interface MathSpan extends MathMatch {
  /** Offset of the opening delimiter. */
  from: number;
  /** Offset just past the closing delimiter (same as `end`). */
  to: number;
}

const isWhitespace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";

/**
 * Tries to read one math span whose opening `$` is at `pos`. Returns null when
 * the text there is not math — the caller then treats the `$` as ordinary text.
 */
export function matchMathAt(text: string, pos: number): MathMatch | null {
  if (text[pos] !== "$") return null;
  return text[pos + 1] === "$" ? matchDisplay(text, pos) : matchInline(text, pos);
}

function matchDisplay(text: string, pos: number): MathMatch | null {
  for (let i = pos + 2; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++; // an escaped character can never close the formula
      continue;
    }
    if (ch === "\n" && isBlankLineAhead(text, i)) return null;
    if (ch === "$" && text[i + 1] === "$") {
      const source = text.slice(pos + 2, i);
      if (source.trim() === "") return null;
      return { end: i + 2, source, display: true };
    }
  }
  return null;
}

/** True when the newline at `i` is followed by a line that is empty/whitespace. */
function isBlankLineAhead(text: string, i: number): boolean {
  let j = i + 1;
  while (j < text.length && text[j] !== "\n" && isWhitespace(text[j])) j++;
  return j >= text.length || text[j] === "\n";
}

function matchInline(text: string, pos: number): MathMatch | null {
  const first = text[pos + 1];
  if (first === undefined || isWhitespace(first)) return null;
  for (let i = pos + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") return null;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch !== "$") continue;
    // The first unescaped `$` decides it: either it is a valid closer or this
    // opener is not math. Scanning on to a later `$` would pair `$5` with the
    // `$` of an unrelated `$x$` further along the line.
    if (isWhitespace(text[i - 1]) || isDigit(text[i + 1])) return null;
    return { end: i + 1, source: text.slice(pos + 1, i), display: false };
  }
  return null;
}

/** Opening fence line of a fenced code block (optionally quoted/indented). */
const FENCE_OPEN_RE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})/;

/** Returns the offset just past the fenced block starting at `lineStart`, or -1. */
function skipFence(text: string, lineStart: number): number {
  const lineEnd = lineEndOf(text, lineStart);
  const open = FENCE_OPEN_RE.exec(text.slice(lineStart, lineEnd));
  if (!open) return -1;
  const fence = open[1];
  const marker = fence[0];
  let cursor = lineEnd + 1;
  while (cursor < text.length) {
    const end = lineEndOf(text, cursor);
    const line = text.slice(cursor, end).replace(/^(?:[ \t]*>)*[ \t]*/, "");
    const run = /^(`+|~+)[ \t]*$/.exec(line);
    if (run && run[1][0] === marker && run[1].length >= fence.length) return end + 1;
    cursor = end + 1;
  }
  return text.length; // unclosed fence runs to the end of the document
}

function lineEndOf(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl === -1 ? text.length : nl;
}

/**
 * Returns the offset just past the code span opened by the backtick run at
 * `pos`, or -1 when the run never closes (a lone backtick is literal text).
 */
function skipCodeSpan(text: string, pos: number): number {
  let runLength = 0;
  while (text[pos + runLength] === "`") runLength++;
  let i = pos + runLength;
  while (i < text.length) {
    if (text[i] === "\n" && isBlankLineAhead(text, i)) return -1; // spans stop at paragraph breaks
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let closeLength = 0;
    while (text[i + closeLength] === "`") closeLength++;
    if (closeLength === runLength) return i + closeLength;
    i += closeLength;
  }
  return -1;
}

/**
 * Finds every math span in `text`, in document order, at or after `from`
 * (callers pass the offset just past frontmatter). `from` must sit on a line
 * boundary so fence detection sees whole lines.
 */
export function findMathSpans(text: string, from = 0): MathSpan[] {
  const spans: MathSpan[] = [];
  let i = from;
  while (i < text.length) {
    if (i === 0 || text[i - 1] === "\n") {
      const past = skipFence(text, i);
      if (past !== -1) {
        i = past;
        continue;
      }
    }
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      const past = skipCodeSpan(text, i);
      if (past !== -1) {
        i = past;
        continue;
      }
      while (text[i] === "`") i++; // literal backticks
      continue;
    }
    if (ch === "$") {
      const match = matchMathAt(text, i);
      if (match) {
        spans.push({ ...match, from: i, to: match.end });
        i = match.end;
        continue;
      }
      i += text[i + 1] === "$" ? 2 : 1;
      continue;
    }
    i++;
  }
  return spans;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Renders LaTeX to an HTML string. Never throws: invalid LaTeX degrades to an
 * error-styled span that keeps the author's source visible, so one typo can
 * neither blank the surrounding note nor crash the editor.
 *
 * `trust` stays off (KaTeX's default), which is what blocks `\href{javascript:…}`
 * and `\includegraphics` in notes pulled from elsewhere. `strict: "ignore"`
 * silences KaTeX's per-formula console warnings (unicode in math, etc.) —
 * Obsidian's MathJax accepts all of that without complaint.
 */
export function renderMathHtml(source: string, display: boolean): string {
  const kind = display ? "math-block" : "math-inline";
  try {
    const rendered = katex.renderToString(source, {
      displayMode: display,
      throwOnError: true,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
    });
    return `<span class="math ${kind}">${rendered}</span>`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const delimiter = display ? "$$" : "$";
    return `<span class="math ${kind} math-error" title="${escapeHtml(message)}">${escapeHtml(
      `${delimiter}${source}${delimiter}`
    )}</span>`;
  }
}
