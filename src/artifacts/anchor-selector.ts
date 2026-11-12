import { INSPECTOR_CAPS } from "./inspector-protocol";

/**
 * The selector grammar subset the guest will execute for a stored anchor (ADR 0006 addendum 2, A2.7).
 *
 * A stored selector comes from a file that may have been edited by a person, an agent or an attacker, so the guest
 * never hands arbitrary text to `querySelectorAll`. It runs only what its own generator emits:
 *
 *   selector := compound ((" " | " > ") compound){0,11}
 *   compound := (tag | "*")? ( #ident | .ident | [attr] | [attr="value"]
 *                            | :nth-child(int) | :nth-of-type(int)
 *                            | :first-child | :last-child | :first-of-type | :last-of-type )*
 *
 * with attr `[A-Za-z_:][-A-Za-z0-9_:.]*`, a double-quoted value of at most 120 units in which only `\"` and `\\` are
 * escapes, idents that may contain CSS escapes, and a total length of at most 512. Everything else (`:has`, `:is`,
 * `:where`, `:not`, pseudo-elements, sibling combinators, namespaces, lists, case flags, comments) is rejected, which
 * bounds a query to a linear scan and removes selector-list and `:has` blowups.
 *
 * Pure, dependency-free, a single left-to-right pass (no regex backtracking), and never throws.
 */

const isAsciiLetter = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isHex = (c: number): boolean => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isNameStart = (c: number): boolean => isAsciiLetter(c) || c === 0x5f || c >= 0x80;
const isNameChar = (c: number): boolean => isNameStart(c) || isDigit(c) || c === 0x2d;
const isControl = (c: number): boolean => c < 0x20 || c === 0x7f;
const MAX_NTH_DIGITS = 6;
const SIMPLE_PSEUDOS = ["first-child", "last-child", "first-of-type", "last-of-type"] as const;

/** Index after a CSS escape that starts at `i` (a backslash), or -1. */
function skipEscape(s: string, i: number): number {
  const next = i + 1;
  if (next >= s.length) return -1;
  const c = s.charCodeAt(next);
  if (isControl(c)) return -1; // also rejects a newline: a backslash-newline is not an escape
  if (!isHex(c)) return next + 1;
  let j = next;
  while (j < s.length && j - next < 6 && isHex(s.charCodeAt(j))) j++;
  return s[j] === " " ? j + 1 : j; // one optional space terminates a hex escape (what the generator writes)
}

/** Index after an identifier that starts at `i`, or -1. */
function skipIdent(s: string, i: number): number {
  let j = i;
  const startsEscape = (k: number): boolean => s.charCodeAt(k) === 0x5c;
  if (s.charCodeAt(j) === 0x2d) {
    j++;
    if (s.charCodeAt(j) === 0x2d) j++;
    else if (!(j < s.length && (isNameStart(s.charCodeAt(j)) || startsEscape(j)))) return -1;
  } else if (!(j < s.length && (isNameStart(s.charCodeAt(j)) || startsEscape(j)))) {
    return -1;
  }
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 0x5c) {
      const next = skipEscape(s, j);
      if (next < 0) return -1;
      j = next;
    } else if (isNameChar(c)) {
      j++;
    } else {
      break;
    }
  }
  return j;
}

/** Index after `[...]` whose body starts at `i` (just past the "["), or -1. */
function skipAttribute(s: string, i: number): number {
  let j = i;
  const first = s.charCodeAt(j);
  if (!(isAsciiLetter(first) || first === 0x5f || first === 0x3a)) return -1;
  j++;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isAsciiLetter(c) || isDigit(c) || c === 0x2d || c === 0x5f || c === 0x3a || c === 0x2e) j++;
    else break;
  }
  if (s[j] === "]") return j + 1;
  if (!s.startsWith('="', j)) return -1;
  j += 2;
  let units = 0;
  for (;;) {
    if (j >= s.length) return -1;
    const c = s.charCodeAt(j);
    if (c === 0x22) { j++; break; }
    if (isControl(c)) return -1;
    if (c === 0x5c) {
      const e = s[j + 1];
      if (e !== '"' && e !== "\\") return -1;
      j += 2;
    } else {
      j++;
    }
    if (++units > INSPECTOR_CAPS.anchorAttributeValueUnits) return -1;
  }
  return s[j] === "]" ? j + 1 : -1;
}

/** Index after the pseudo-class whose name starts at `i` (just past the ":"), or -1. */
function skipPseudo(s: string, i: number): number {
  for (const name of SIMPLE_PSEUDOS) if (s.startsWith(name, i)) return i + name.length;
  for (const name of ["nth-child(", "nth-of-type("]) {
    if (!s.startsWith(name, i)) continue;
    let j = i + name.length;
    const digits = j;
    while (j < s.length && isDigit(s.charCodeAt(j))) j++;
    const count = j - digits;
    if (count < 1 || count > MAX_NTH_DIGITS || s[j] !== ")") return -1;
    return j + 1;
  }
  return -1;
}

/** Index after the compound that starts at `i`, or -1 (empty compounds are invalid). */
function skipCompound(s: string, i: number): number {
  let j = i;
  if (s[j] === "*") {
    j++;
  } else if (j < s.length && isAsciiLetter(s.charCodeAt(j))) {
    j++;
    while (j < s.length && (isAsciiLetter(s.charCodeAt(j)) || isDigit(s.charCodeAt(j)) || s.charCodeAt(j) === 0x2d)) j++;
  }
  for (;;) {
    const c = s[j];
    let next: number;
    if (c === "#" || c === ".") next = skipIdent(s, j + 1);
    else if (c === "[") next = skipAttribute(s, j + 1);
    else if (c === ":") next = skipPseudo(s, j + 1);
    else break;
    if (next < 0) return -1;
    j = next;
  }
  return j === i ? -1 : j;
}

export function isRestrictedSelector(selector: unknown): boolean {
  if (typeof selector !== "string") return false;
  const n = selector.length;
  if (n === 0 || n > INSPECTOR_CAPS.selectorUnits) return false;
  let i = 0;
  for (let compounds = 1; ; compounds++) {
    if (compounds > INSPECTOR_CAPS.anchorSelectorCompounds) return false;
    const end = skipCompound(selector, i);
    if (end < 0) return false;
    if (end === n) return true;
    if (selector.startsWith(" > ", end)) i = end + 3;
    else if (selector[end] === " ") i = end + 1;
    else return false;
  }
}
