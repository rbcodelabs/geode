import { decodeMarkdownDestination } from "../../wiki/markdown-destination";
import { ABSENT_SPAN, IMAGE_FLAGS, validatePackedImages } from "./packed";
import type { ImageSourceContext, ImageSourceFile, ImageProjectionResult, OwnedImageOccurrence, OwnedImageProjection } from "./source";
export interface AsyncImageSourceContext<T extends ImageSourceFile> extends ImageSourceContext<T> {
  readonly resolutionEpoch: object;
  currentResolutionEpoch(): object;
}
export interface ImageParseTransport { parse(source: string, signal?: AbortSignal): Promise<unknown> }
interface Captured<T extends ImageSourceFile> extends AsyncImageSourceContext<T> { readonly ownerPath: string }
const contexts = new WeakMap<object, Captured<ImageSourceFile>>();
const raster = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]);
const token = (value: unknown): value is object => typeof value === "object" && value !== null;
function localPath(path: string): boolean {
  return !!path && !/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[\\/]/.test(path) && !/[\\\0]/.test(path) && !path.startsWith("@ext/") && !path.split("/").some(part => !part || part === "." || part === "..");
}
function current(context: Captured<ImageSourceFile>): boolean {
  return token(context.resolutionEpoch) && typeof context.currentResolutionEpoch === "function" && context.currentResolutionEpoch() === context.resolutionEpoch
    && context.currentVault() === context.vault && context.currentRoot() === context.root && context.currentSnapshot() === context.snapshot
    && context.owner.path === context.ownerPath && context.fileByPath(context.ownerPath) === context.owner;
}
export function isImageProjectionCurrent(projection: OwnedImageProjection, source: string): boolean {
  const context = contexts.get(projection);
  return !!context && source === projection.source && current(context)
    && projection.occurrences.every(item => !item.file || item.file.path === item.resolvedPath && context.fileByPath(item.resolvedPath!) === item.file);
}
/** Private asynchronous foundation. Transport owns parsing; there is no host parser fallback. */
export async function projectPackedOwnedImages<T extends ImageSourceFile>(input: AsyncImageSourceContext<T>, transport: ImageParseTransport,
  options: { batchSize?: number; yieldControl?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<ImageProjectionResult<T>> {
  const source = input.source;
  if (source.length > 300_000) return { status: "unsupported", reason: "source-limit" };
  if (source.includes("\r")) return { status: "unsupported", reason: "non-lf-source" };
  if (!token(input.resolutionEpoch) || typeof input.currentResolutionEpoch !== "function") return { status: "unsupported", reason: "stale-owner" };
  const context: Captured<T> = Object.freeze({ ...input, ownerPath: input.owner.path,
    currentResolutionEpoch: input.currentResolutionEpoch.bind(input), currentVault: input.currentVault.bind(input), currentRoot: input.currentRoot.bind(input), currentSnapshot: input.currentSnapshot.bind(input),
    fileByPath: input.fileByPath.bind(input), resolve: input.resolve.bind(input) });
  let staleTarget = false;
  const valid = () => !options.signal?.aborted && !staleTarget && current(context);
  const occurrences: OwnedImageOccurrence<T>[] = [];
  if (!valid() || !localPath(context.ownerPath)) return { status: "unsupported", reason: "stale-owner" };
  const raw = await transport.parse(source, options.signal);
  if (!valid()) return { status: "unsupported", reason: "stale-owner" };
  const packed = validatePackedImages(source, raw);
  const decoded = new Map<string, string>();
  const text = (from: number, to: number, rule: "literal" | "wiki" | "destination"): string => {
    if (from === ABSENT_SPAN) return "";
    const key = `${from}:${to}:${rule}`;
    const existing = decoded.get(key); if (existing !== undefined) return existing;
    const authored = source.slice(from, to), value = rule === "wiki" ? authored.trim() : rule === "destination" ? decodeMarkdownDestination(authored) : authored;
    decoded.set(key, value); return value;
  };
  type Resolution = { file: T | null; resolvedPath: string | null; status: "ready" | "missing" | "error"; issue?: string };
  const resolved = new Map<string, Resolution>();
  const resolve = (target: string): Resolution => {
    const existing = resolved.get(target);
    if (existing) {
      if (existing.file && (existing.file.path !== existing.resolvedPath || context.fileByPath(existing.resolvedPath!) !== existing.file)) staleTarget = true;
      return existing;
    }
    const path = target.split("#")[0]; let value: Resolution;
    if (!localPath(path)) value = { file: null, resolvedPath: null, status: "missing", issue: "unauthorized-target" };
    else {
      let file: T | null;
      try { file = context.resolve(target, context.ownerPath); }
      catch { return { file: null, resolvedPath: null, status: "error" }; }
      if (!file && !raster.has(path.split(".").at(-1)!.toLowerCase())) value = { file: null, resolvedPath: null, status: "missing", issue: "unsupported-target" };
      else if (file && (!localPath(file.path) || !raster.has(file.extension.toLowerCase()) || context.fileByPath(file.path) !== file)) value = { file: null, resolvedPath: null, status: "missing", issue: "unindexed-target" };
      else value = { file, resolvedPath: file?.path ?? null, status: file ? "ready" : "missing" };
    }
    resolved.set(target, value); return value;
  };
  type Issue = { from: number; to: number; reason: string };
  const issues: Issue[] = [], wikiIssues: Issue[] = [], markdownIssues: Issue[] = [];
  for (let i = 0; i < packed.issues.length; i += 3) issues.push({ from: packed.issues[i], to: packed.issues[i+1], reason: "unsupported-syntax" });
  const requestedBatch = options.batchSize ?? 200;
  const batchSize = Number.isSafeInteger(requestedBatch) && requestedBatch > 0 ? Math.min(requestedBatch, 200) : 200;
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  for (let i = 0; i < packed.candidates.length; i += 12) {
    if (!valid()) return { status: "unsupported", reason: "stale-owner" };
    const row = packed.candidates.subarray(i, i+12), wiki = !!(row[9] & IMAGE_FLAGS.wiki), definition = row[8];
    const def = definition === ABSENT_SPAN ? null : packed.definitions.subarray(definition * 6, definition * 6 + 6);
    const targetFrom = def ? def[2] : row[4], targetTo = def ? def[3] : row[5];
    const authoredTarget = text(targetFrom, targetTo, wiki ? "wiki" : "literal"), target = text(targetFrom, targetTo, wiki ? "wiki" : "destination");
    const title = row[6] !== ABSENT_SPAN ? text(row[6], row[7], "literal") : def ? text(def[4], def[5], "literal") : "";
    const result = resolve(target);
    if (result.issue) (wiki ? wikiIssues : markdownIssues).push({ from: row[0], to: row[1], reason: result.issue });
    else occurrences.push(Object.freeze({ key: Object.freeze({}), from: row[0], to: row[1], authoredTarget, target,
      label: text(row[2], row[3], wiki ? "wiki" : "literal"), title, linked: !!(row[9] & IMAGE_FLAGS.linked), file: result.file, resolvedPath: result.resolvedPath, status: result.status }));
    if ((i / 12 + 1) % batchSize === 0 && i + 12 < packed.candidates.length) { await yieldControl(); if (!valid()) return { status: "unsupported", reason: "stale-owner" }; }
  }
  let checkedTargets = 0;
  for (const result of resolved.values()) {
    if (!valid() || result.file && (result.file.path !== result.resolvedPath || context.fileByPath(result.resolvedPath!) !== result.file)) return { status: "unsupported", reason: "stale-owner" };
    if (++checkedTargets % batchSize === 0 && checkedTargets < resolved.size) { await yieldControl(); if (!valid()) return { status: "unsupported", reason: "stale-owner" }; }
  }
  if (!valid()) return { status: "unsupported", reason: "stale-owner" };
  const projection: OwnedImageProjection<T> = Object.freeze({ status: "ready", source, occurrences: Object.freeze(occurrences), issues: Object.freeze([...issues, ...wikiIssues, ...markdownIssues].map(issue => Object.freeze(issue))) });
  contexts.set(projection, context); return projection;
}
