/**
 * marked integration for math: teaches a `Marked` instance to tokenize
 * `$inline$` and `$$block$$` using the delimiter rules in `./math`.
 *
 * The tokenizers run ahead of marked's own, so `_` / `*` / `<` inside a
 * formula are consumed here and never reach emphasis or HTML parsing. Code
 * spans and fenced blocks need no special handling: marked reaches a backtick
 * or fence first and consumes it whole, and `\$` is claimed by marked's
 * escape rule before this tokenizer ever sees the `$`.
 */
import type { Marked, TokenizerAndRendererExtension } from "marked";
import { matchMathAt, renderMathHtml } from "./math";
import { ensureMathStyles } from "./math-style";

interface MathToken {
  type: string;
  raw: string;
  text: string;
  display: boolean;
}

const inlineMath: TokenizerAndRendererExtension = {
  name: "inlineMath",
  level: "inline",
  start(src: string) {
    const at = src.indexOf("$");
    return at === -1 ? undefined : at;
  },
  tokenizer(src: string): MathToken | undefined {
    const match = matchMathAt(src, 0);
    if (!match) return undefined;
    return {
      type: "inlineMath",
      raw: src.slice(0, match.end),
      text: match.source,
      display: match.display,
    };
  },
  renderer(token) {
    ensureMathStyles();
    const { text, display } = token as unknown as MathToken;
    return renderMathHtml(text, display);
  },
};

/** A `$$` formula that owns its lines: only whitespace before it and after it. */
const BLOCK_START_RE = /^ {0,3}\$\$/;

const blockMath: TokenizerAndRendererExtension = {
  name: "blockMath",
  level: "block",
  start(src: string) {
    const at = src.search(/(?:^|\n) {0,3}\$\$/);
    if (at === -1) return undefined;
    return src[at] === "\n" ? at + 1 : at;
  },
  tokenizer(src: string): MathToken | undefined {
    const opener = BLOCK_START_RE.exec(src);
    if (!opener) return undefined;
    const openAt = opener[0].length - 2;
    const match = matchMathAt(src, openAt);
    if (!match?.display) return undefined;
    const lineEnd = src.indexOf("\n", match.end);
    const tail = src.slice(match.end, lineEnd === -1 ? src.length : lineEnd);
    // Text after the closing `$$` makes it part of a paragraph; the inline
    // tokenizer then renders it as display math within that paragraph.
    if (tail.trim() !== "") return undefined;
    const rawEnd = lineEnd === -1 ? src.length : lineEnd + 1;
    return {
      type: "blockMath",
      raw: src.slice(0, rawEnd),
      text: match.source,
      display: true,
    };
  },
  renderer(token) {
    ensureMathStyles();
    const { text } = token as unknown as MathToken;
    return `${renderMathHtml(text, true)}\n`;
  },
};

export function installMathExtensions(marked: Marked): void {
  marked.use({ extensions: [blockMath, inlineMath] });
}
