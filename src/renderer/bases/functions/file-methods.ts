import { evaluateArgs } from "../evaluator";
import { fileNamespaceField } from "../property-path";
import { BaseValue, bool, linkValue, nullValue } from "../value";
import { MethodFn } from "./any-methods";

/** Field names shared with the `file`/`this` property-namespace table (see property-path.ts). */
const FIELD_NAMES = [
  "name",
  "basename",
  "path",
  "folder",
  "ext",
  "size",
  "ctime",
  "mtime",
  "tags",
  "links",
  "backlinks",
  "embeds",
  "properties",
  "file",
] as const;

export const FILE_METHODS: Record<string, MethodFn> = {};

for (const name of FIELD_NAMES) {
  FILE_METHODS[name] = (target, _args, ctx) =>
    target.type === "file" ? fileNamespaceField(target.value, name, ctx) : nullValue();
}

FILE_METHODS.asLink = (target, args, ctx) => {
  if (target.type !== "file") return nullValue();
  const [displayArg] = evaluateArgs(args, ctx);
  const display = displayArg?.type === "string" ? displayArg.value : undefined;
  return linkValue(target.value.path, target.value, display);
};

FILE_METHODS.hasLink = (target, args, ctx) => {
  if (target.type !== "file") return nullValue();
  const [arg] = evaluateArgs(args, ctx);
  if (!arg) return bool(false);
  const cache = ctx.metadataCache.getFileCache(target.value);
  const linkTargets = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].map((l) =>
    ctx.metadataCache.getFirstLinkpathDest(l.link, target.value.path)
  );
  if (arg.type === "file") return bool(linkTargets.some((t) => t?.path === arg.value.path));
  if (arg.type === "string") {
    const resolved = ctx.metadataCache.getFirstLinkpathDest(arg.value, target.value.path);
    return bool(!!resolved && linkTargets.some((t) => t?.path === resolved.path));
  }
  return bool(false);
};

FILE_METHODS.hasProperty = (target, args, ctx) => {
  if (target.type !== "file") return nullValue();
  const [nameArg] = evaluateArgs(args, ctx);
  if (nameArg?.type !== "string") return bool(false);
  const fm = ctx.metadataCache.getFileCache(target.value)?.frontmatter;
  return bool(!!fm && nameArg.value in fm);
};

FILE_METHODS.hasTag = (target, args, ctx) => {
  if (target.type !== "file") return nullValue();
  const values = evaluateArgs(args, ctx)
    .filter((v): v is Extract<BaseValue, { type: "string" }> => v.type === "string")
    .map((v) => v.value.replace(/^#/, ""));
  if (!values.length) return bool(false);
  const tags = (ctx.metadataCache.getFileCache(target.value)?.tags ?? []).map((t) => t.tag);
  return bool(values.some((v) => tags.some((t) => t === v || t.startsWith(v + "/"))));
};

FILE_METHODS.inFolder = (target, args, ctx) => {
  if (target.type !== "file") return nullValue();
  const [folderArg] = evaluateArgs(args, ctx);
  if (folderArg?.type !== "string") return bool(false);
  const folder = folderArg.value.replace(/\/$/, "");
  const fileFolder = target.value.parent;
  return bool(fileFolder === folder || fileFolder.startsWith(folder + "/"));
};
