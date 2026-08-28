/**
 * Pure fenced-code parsing shared by the two view modes that render Mermaid.
 *
 * Reading view never needs this — `runCodeBlockProcessors` already dispatches
 * by the `language-*` class Marked emits — but Live Preview works off raw
 * document text inside a Lezer `FencedCode` node, so it has to recover the
 * info string and body itself. Keeping that logic here (a leaf module with no
 * DOM, CodeMirror, or App import) means the language-detection rule can be
 * unit-tested directly and can't drift between the two paths.
 */

/** The fenced-code language Geode registers the Mermaid processor under. */
export const MERMAID_LANG = "mermaid";

/**
 * True when a fenced block's info string selects the Mermaid language.
 *
 * Only the first word of the info string is the language (CommonMark); the
 * remainder is arbitrary metadata. Matching is case-insensitive and exact, so
 * `mermaid` and `Mermaid {theme}` match while `mermaidjs`, `js`, and
 * `mermaid-cli` do not — a prefix match would hijack unrelated languages.
 */
export function isMermaidInfoString(info: string): boolean {
  return firstWord(info).toLowerCase() === MERMAID_LANG;
}

function firstWord(info: string): string {
  const trimmed = info.trim();
  const boundary = trimmed.search(/[\s{]/);
  return boundary === -1 ? trimmed : trimmed.slice(0, boundary);
}

/** A fenced code block split into its info string and its body text. */
export interface FencedBlock {
  /** Everything after the opening fence on the first line, trimmed. */
  info: string;
  /** The block's content, without the opening or closing fence lines. */
  body: string;
}

/**
 * Split raw fenced-code source (opening fence line through closing fence)
 * into its info string and body. Returns null when `raw` does not start with a
 * fence.
 *
 * An unclosed fence is valid Markdown — CodeMirror hands us a `FencedCode`
 * node for a block the user is still typing — so a missing closing fence
 * yields the whole remainder as the body rather than failing.
 */
export function parseFencedBlock(raw: string): FencedBlock | null {
  const lines = raw.split("\n");
  const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[0]);
  if (!open) return null;
  const [, marker, info] = open;
  const closeRe = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}\\s*$`);
  let end = lines.length;
  for (let i = lines.length - 1; i >= 1; i--) {
    if (closeRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { info: info.trim(), body: lines.slice(1, end).join("\n") };
}
