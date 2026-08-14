/**
 * Hand-written scanner for the Bases expression grammar (see `docs/spec/02-core-plugins.md`,
 * "Bases" section). Mirrors the house style of `parseQuery` in
 * `src/renderer/views/search-view.ts` — no parser-generator library — but for
 * a much richer grammar, so it's a proper character-at-a-time scanner rather
 * than a single regex.
 *
 * Never throws: unrecognized characters are silently skipped so a malformed
 * expression always produces *some* token stream, letting `parser.ts` decide
 * how to report the problem.
 */

export type TokenType =
  | "number"
  | "string"
  | "identifier"
  | "true"
  | "false"
  | "and"
  | "or"
  | "not"
  | "dot"
  | "comma"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "percent"
  | "regex"
  | "eof";

export interface Token {
  type: TokenType;
  /** Raw source text of the token. */
  text: string;
  /** Parsed value for "number" (as a number) and "string" (unescaped); null otherwise. */
  value: string | number | null;
  /** Offset of the first character of the token in the source string. */
  start: number;
  /** Offset just past the last character of the token. */
  end: number;
}

// A `Map`, not a plain object: identifiers like "toString" or "constructor"
// (both real Any-type method names in this grammar — see functions/any-
// methods.ts) would otherwise silently resolve to an inherited
// `Object.prototype` member via `{}[text]` instead of `undefined`, corrupting
// the token type for any expression that calls `.toString()`.
const KEYWORDS = new Map<string, TokenType>([
  ["true", "true"],
  ["false", "false"],
  ["and", "and"],
  ["or", "or"],
  ["not", "not"],
]);

function isDigit(c: string | undefined): boolean {
  return !!c && c >= "0" && c <= "9";
}

function isIdentStart(c: string | undefined): boolean {
  return !!c && /[A-Za-z_]/.test(c);
}

function isIdentPart(c: string | undefined): boolean {
  return !!c && /[A-Za-z0-9_]/.test(c);
}

function unescapeChar(c: string): string {
  switch (c) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "\\":
      return "\\";
    case "'":
      return "'";
    case '"':
      return '"';
    default:
      return c;
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;

  const push = (type: TokenType, start: number, end: number, value: string | number | null = null) => {
    tokens.push({ type, text: source.slice(start, end), value, start, end });
  };

  while (i < n) {
    const c = source[i];

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }

    const start = i;

    // Strings: both 'x' and "x" produce the same "string" token type.
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      let value = "";
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          value += unescapeChar(source[i + 1]);
          i += 2;
        } else {
          value += source[i];
          i++;
        }
      }
      if (i < n) i++; // consume closing quote; if unterminated (EOF), tolerate and stop here
      push("string", start, i, value);
      continue;
    }

    // Numbers: 1, 2.5 (no leading sign here — unary +/- is a parser concern).
    if (isDigit(c)) {
      let j = i;
      while (isDigit(source[j])) j++;
      if (source[j] === "." && isDigit(source[j + 1])) {
        j++;
        while (isDigit(source[j])) j++;
      }
      push("number", start, j, Number(source.slice(start, j)));
      i = j;
      continue;
    }

    // Identifiers / keywords.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (isIdentPart(source[j])) j++;
      const text = source.slice(start, j);
      push(KEYWORDS.get(text) ?? "identifier", start, j, null);
      i = j;
      continue;
    }

    switch (c) {
      case ".":
        push("dot", start, i + 1);
        i++;
        continue;
      case ",":
        push("comma", start, i + 1);
        i++;
        continue;
      case "(":
        push("lparen", start, i + 1);
        i++;
        continue;
      case ")":
        push("rparen", start, i + 1);
        i++;
        continue;
      case "[":
        push("lbracket", start, i + 1);
        i++;
        continue;
      case "]":
        push("rbracket", start, i + 1);
        i++;
        continue;
      case "+":
        push("plus", start, i + 1);
        i++;
        continue;
      case "-":
        push("minus", start, i + 1);
        i++;
        continue;
      case "*":
        push("star", start, i + 1);
        i++;
        continue;
      case "/":
        // Division vs. regex-literal ambiguity is resolved by the parser,
        // not here — see scanRegexLiteral() below.
        push("slash", start, i + 1);
        i++;
        continue;
      case "%":
        push("percent", start, i + 1);
        i++;
        continue;
      case "=":
        if (source[i + 1] === "=") {
          push("eq", start, i + 2);
          i += 2;
        } else {
          i++; // lone '=' isn't part of the grammar; drop it
        }
        continue;
      case "!":
        if (source[i + 1] === "=") {
          push("neq", start, i + 2);
          i += 2;
        } else {
          i++;
        }
        continue;
      case ">":
        if (source[i + 1] === "=") {
          push("gte", start, i + 2);
          i += 2;
        } else {
          push("gt", start, i + 1);
          i++;
        }
        continue;
      case "<":
        if (source[i + 1] === "=") {
          push("lte", start, i + 2);
          i += 2;
        } else {
          push("lt", start, i + 1);
          i++;
        }
        continue;
      default:
        i++; // unrecognized character: skip silently, never throw
        continue;
    }
  }

  tokens.push({ type: "eof", text: "", value: null, start: n, end: n });
  return tokens;
}

/**
 * Re-scan a regex literal starting at `start` (which must point at the `/`
 * delimiter). Called by `parser.ts` when a `slash` token appears where a
 * primary expression is expected — the only position a regex literal can
 * start, since division always follows a left operand. Scans to the next
 * unescaped `/`, then any trailing flag letters. Returns `null` (never
 * throws) if the literal is unterminated before end-of-source or a newline.
 */
export function scanRegexLiteral(
  source: string,
  start: number
): { source: string; flags: string; end: number } | null {
  if (source[start] !== "/") return null;
  let i = start + 1;
  let pattern = "";
  let closed = false;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\" && i + 1 < source.length) {
      pattern += c + source[i + 1];
      i += 2;
      continue;
    }
    if (c === "/") {
      closed = true;
      i++;
      break;
    }
    if (c === "\n") break;
    pattern += c;
    i++;
  }
  if (!closed) return null;
  let flags = "";
  while (i < source.length && /[A-Za-z]/.test(source[i])) {
    flags += source[i];
    i++;
  }
  return { source: pattern, flags, end: i };
}
