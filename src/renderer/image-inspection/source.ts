import type { SyntaxNode } from "@lezer/common";
import { maskMarkdownCode } from "../../wiki/code-mask";
import { FRONTMATTER_BLOCK_RE } from "../../wiki/constants";
import { metadataMarkdownParser, normalizeMarkdownReferenceLabel, decodeMarkdownDestination } from "../../wiki/markdown-references";
import { maskCommentMetadata } from "../comments/model";

export interface ImageSourceFile { readonly path: string; readonly extension: string }
export interface ImageSourceContext<T extends ImageSourceFile> {
  readonly source: string;
  readonly owner: T;
  readonly vault: object;
  readonly root: string;
  readonly snapshot: object;
  currentVault(): object;
  currentRoot(): string;
  currentSnapshot(): object;
  fileByPath(path: string): T | null;
  resolve(target: string, sourcePath: string): T | null;
}
export interface OwnedImageOccurrence<T extends ImageSourceFile = ImageSourceFile> {
  readonly key: object;
  readonly from: number;
  readonly to: number;
  readonly authoredTarget: string;
  readonly target: string;
  readonly label: string;
  readonly title: string;
  readonly linked: boolean;
  readonly file: T | null;
  readonly resolvedPath: string | null;
  readonly status: "ready" | "missing" | "error";
}
export interface OwnedImageProjection<T extends ImageSourceFile = ImageSourceFile> {
  readonly status: "ready";
  readonly source: string;
  readonly occurrences: readonly OwnedImageOccurrence<T>[];
  readonly issues: readonly { from: number; to: number; reason: string }[];
}
export type ImageProjectionResult<T extends ImageSourceFile> = OwnedImageProjection<T> | {
  status: "unsupported"; reason: "source-limit" | "non-lf-source" | "stale-owner";
};
type CapturedContext<T extends ImageSourceFile> = ImageSourceContext<T> & { readonly ownerPath: string };
const contexts = new WeakMap<object, CapturedContext<ImageSourceFile>>();
const raster = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);
const blank = (value: string) => value.replace(/[^\n]/g, " ");

function localPath(path: string): boolean {
  return !!path && !/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[\\/]/.test(path)
    && !/[\\\0]/.test(path) && !path.startsWith("@ext/")
    && !path.split("/").some(part => !part || part === "." || part === "..");
}
function current(context: CapturedContext<ImageSourceFile>): boolean {
  return context.currentVault() === context.vault && context.currentRoot() === context.root
    && context.currentSnapshot() === context.snapshot && context.owner.path === context.ownerPath
    && context.fileByPath(context.ownerPath) === context.owner;
}
export function isImageProjectionCurrent(projection: OwnedImageProjection, source: string): boolean {
  const context = contexts.get(projection);
  return !!context && source === projection.source && current(context)
    && projection.occurrences.every(item => !item.file || item.file.path === item.resolvedPath && context.fileByPath(item.resolvedPath!) === item.file);
}
function ancestor(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === name) return parent;
  return null;
}
function escaped(source: string, from: number): boolean {
  let start = from;
  while (start && source[start - 1] === "\\") start--;
  return (from - start) % 2 === 1;
}

/** This private projection grants no authority to renderer/plugin/transcluded DOM. */
export function projectOwnedImages<T extends ImageSourceFile>(input: ImageSourceContext<T>): ImageProjectionResult<T> {
  const source = input.source;
  if (source.length > 300_000) return { status: "unsupported", reason: "source-limit" };
  if (source.includes("\r")) return { status: "unsupported", reason: "non-lf-source" };
  const context: CapturedContext<T> = Object.freeze({ ...input, ownerPath: input.owner.path,
    currentVault: input.currentVault.bind(input), currentRoot: input.currentRoot.bind(input), currentSnapshot: input.currentSnapshot.bind(input),
    fileByPath: input.fileByPath.bind(input), resolve: input.resolve.bind(input) });
  if (!current(context) || !localPath(context.owner.path)) return { status: "unsupported", reason: "stale-owner" };
  let masked = maskMarkdownCode(maskCommentMetadata(source));
  if (masked.startsWith("---\n")) {
    const frontmatter = FRONTMATTER_BLOCK_RE.exec(masked);
    const end = frontmatter?.[0].length ?? masked.length;
    masked = blank(masked.slice(0, end)) + masked.slice(end);
  }
  const comments: string[] = [];
  let offset = 0;
  while (offset < masked.length) {
    const open = masked.indexOf("%%", offset);
    if (open < 0) break;
    if (escaped(masked, open)) { comments.push(masked.slice(offset, open + 2)); offset = open + 2; continue; }
    let end = masked.indexOf("%%", open + 2);
    while (end >= 0 && escaped(masked, end)) end = masked.indexOf("%%", end + 2);
    end = end < 0 ? masked.length : end + 2;
    comments.push(masked.slice(offset, open), blank(masked.slice(open, end)));
    offset = end;
  }
  comments.push(masked.slice(offset));
  masked = comments.join("");
  const tree = metadataMarkdownParser.parse(masked);
  const excluded: { from: number; to: number }[] = [];
  const definitions = new Map<string, { target: string; authoredTarget: string; title: string }>();
  tree.iterate({ enter(ref) {
    const node = ref.node;
    if (["HTMLBlock", "CommentBlock", "ProcessingInstructionBlock", "CodeBlock", "FencedCode", "InlineCode"].includes(node.name)) {
      excluded.push(node); return false;
    }
    if (node.name === "HTMLTag" && !ancestor(node, "Image")) {
      // Inline HTML containers lack a source-owned image mapping in this phase.
      excluded.push(ancestor(node, "Paragraph") ?? node);
    }
    if (node.name === "LinkReference") {
      const label = node.getChild("LinkLabel"), url = node.getChild("URL"), title = node.getChild("LinkTitle");
      if (label && url) {
        const id = normalizeMarkdownReferenceLabel(masked.slice(label.from + 1, label.to - 1));
        if (!definitions.has(id)) definitions.set(id, {
          authoredTarget: source.slice(url.from, url.to), target: decodeMarkdownDestination(source.slice(url.from, url.to)),
          title: title ? source.slice(title.from + 1, title.to - 1) : "",
        });
      }
    }
  } });
  excluded.sort((a, b) => a.from - b.from || b.to - a.to);
  const intervals: { from: number; to: number }[] = [];
  for (const span of excluded) {
    const last = intervals.at(-1);
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else intervals.push({ from: span.from, to: span.to });
  }
  const omitted = (from: number, to: number) => {
    let low = 0, high = intervals.length;
    while (low < high) { const middle = (low + high) >>> 1; if (intervals[middle].to <= from) low = middle + 1; else high = middle; }
    return low < intervals.length && intervals[low].from < to;
  };
  const occurrences: OwnedImageOccurrence<T>[] = [];
  const issues: { from: number; to: number; reason: string }[] = [];
  const add = (entry: Omit<OwnedImageOccurrence<T>, "key" | "file" | "resolvedPath" | "status">) => {
    const target = entry.target.split("#")[0];
    if (!localPath(target)) { issues.push({ ...entry, reason: "unauthorized-target" }); return; }
    const extension = target.split(".").at(-1)!.toLowerCase();
    let file: T | null;
    try { file = context.resolve(entry.target, context.owner.path); }
    catch { occurrences.push(Object.freeze({ ...entry, key: Object.freeze({}), file: null, resolvedPath: null, status: "error" })); return; }
    if (!file && !raster.has(extension)) { issues.push({ ...entry, reason: "unsupported-target" }); return; }
    if (file && (!localPath(file.path) || !raster.has(file.extension.toLowerCase()) || context.fileByPath(file.path) !== file)) {
      issues.push({ ...entry, reason: "unindexed-target" }); return;
    }
    occurrences.push(Object.freeze({ ...entry, key: Object.freeze({}), file, resolvedPath: file?.path ?? null, status: file ? "ready" : "missing" }));
  };
  for (const match of masked.matchAll(/!\[\[([^\[\]\n]+)\]\]/g)) {
    const from = match.index, to = from + match[0].length;
    if (escaped(masked, from) || omitted(from, to)) continue;
    const node = tree.resolveInner(from + 2, 1);
    let forbidden = false, linked = false;
    for (let parent: SyntaxNode | null = node; parent; parent = parent.parent) {
      if (["URL", "LinkTitle", "LinkReference"].includes(parent.name)
        || (parent.name === "Image" && (parent.from !== from || parent.to !== to))) forbidden = true;
      if (parent.name === "Link" && parent.from < from && parent.to >= to) linked = true;
    }
    if (forbidden) continue;
    const pipe = match[1].indexOf("|");
    const target = (pipe < 0 ? match[1] : match[1].slice(0, pipe)).trim();
    add({ from, to, authoredTarget: target, target, label: pipe < 0 ? target : match[1].slice(pipe + 1).trim(), title: "", linked });
  }
  tree.iterate({ enter(ref) {
    const node = ref.node;
    if (node.name !== "Image") return;
    if (omitted(node.from, node.to) || ancestor(node, "Image") || source.startsWith("![[", node.from)) return false;
    const marks = node.getChildren("LinkMark"), close = marks.find(mark => masked.slice(mark.from, mark.to) === "]");
    if (!close) return false;
    const label = source.slice(node.from + 2, close.from);
    const url = node.getChild("URL"), reference = node.getChild("LinkLabel"), title = node.getChild("LinkTitle");
    const definition = reference ? definitions.get(normalizeMarkdownReferenceLabel(masked.slice(reference.from + 1, reference.to - 1) || label))
      : definitions.get(normalizeMarkdownReferenceLabel(label));
    if (!url && !definition) return false;
    add({ from: node.from, to: node.to, authoredTarget: url ? source.slice(url.from, url.to) : definition!.authoredTarget,
      target: url ? decodeMarkdownDestination(source.slice(url.from, url.to)) : definition!.target,
      label, title: title ? source.slice(title.from + 1, title.to - 1) : definition?.title ?? "", linked: !!ancestor(node, "Link") });
    return false;
  } });
  if (!current(context)) return { status: "unsupported", reason: "stale-owner" };
  occurrences.sort((a, b) => a.from - b.from);
  const result: OwnedImageProjection<T> = Object.freeze({ status: "ready", source,
    occurrences: Object.freeze(occurrences), issues: Object.freeze(issues.map(issue => Object.freeze(issue))) });
  contexts.set(result, context);
  return result;
}
