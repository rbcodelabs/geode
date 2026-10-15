import { parser } from "@lezer/markdown";
import type { LinkCache, ReferenceLinkCache, Loc } from "./types";

// The stock rule rescans ordinary spaces from every position in the run.
// Consuming that run once preserves source positions and all HardBreak nodes.
export const metadataMarkdownParser = parser.configure({ parseInline: [{
  name: "HardBreak",
  parse(context, next, start) {
    if (next === 92 && context.char(start + 1) === 10) {
      return context.addElement(context.elt("HardBreak", start, start + 2));
    }
    if (next !== 32) return -1;
    let end = start + 1;
    while (context.char(end) === 32) end++;
    if (context.char(end) === 10 && end >= start + 2) {
      return context.addElement(context.elt("HardBreak", start, end + 1));
    }
    return end;
  },
}] });

export const normalizeMarkdownReferenceLabel = (label: string) => label.replace(/\s+/g, " ").trim().toLowerCase();
const unescape = (text: string) => text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
export function decodeMarkdownDestination(raw: string): string {
  const value = unescape(raw.replace(/^<([\s\S]*)>$/, "$1"));
  try { return decodeURI(value); } catch { return value; }
}

/** Uses the installed CommonMark grammar; it never treats text inside code as a link. */
export function markdownReferences(body: string, locate: (start: number, end: number) => Loc): { links: LinkCache[]; embeds: LinkCache[]; references: ReferenceLinkCache[] } {
  const tree = metadataMarkdownParser.parse(body);
  const definitions = new Map<string, string>();
  tree.iterate({ enter(node) {
    if (node.name !== "LinkReference") return;
    const label = node.node.getChild("LinkLabel"), url = node.node.getChild("URL");
    if (label && url) {
      const key = normalizeMarkdownReferenceLabel(body.slice(label.from + 1, label.to - 1));
      if (!definitions.has(key)) definitions.set(key, decodeMarkdownDestination(body.slice(url.from, url.to)));
    }
  } });
  const links: LinkCache[] = [], embeds: LinkCache[] = [], references: ReferenceLinkCache[] = [];
  tree.iterate({ enter(node) {
    if (node.name !== "Link" && node.name !== "Image") return;
    const url = node.node.getChild("URL"), label = node.node.getChild("LinkLabel");
    const raw = body.slice(node.from, node.to);
    const isEmbed = node.name === "Image";
    const firstMark = isEmbed ? 2 : 1;
    const firstClose = raw.indexOf("]", firstMark);
    const display = unescape(raw.slice(firstMark, firstClose));
    if (display.startsWith("^")) return false;
    const id = label ? body.slice(label.from + 1, label.to - 1) || display : display;
    const link = url ? decodeMarkdownDestination(body.slice(url.from, url.to)) : definitions.get(normalizeMarkdownReferenceLabel(id));
    if (link === undefined) return false;
    const position = locate(node.from, node.to);
    if (!url) references.push({ id, link, position });
    (isEmbed ? embeds : links).push({ link, displayText: display, position, isEmbed });
    return false;
  } });
  return { links, embeds, references };
}
