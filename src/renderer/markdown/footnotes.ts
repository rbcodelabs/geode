// Shared portable scanner keeps renderer and metadata extraction consistent.
export { scanFootnotes } from "../../wiki/footnote-scan";
export type { FootnoteRefSpan, InlineFootnoteSpan, FootnoteReference, FootnoteDefinitionSpan, FootnoteScan, FootnoteItem } from "../../wiki/footnote-scan";
import { scanFootnotes, type FootnoteItem } from "../../wiki/footnote-scan";

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
