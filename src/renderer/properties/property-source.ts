import { Document, isMap, isScalar, parseDocument } from "yaml";
import { getFrontMatterInfo } from "../api/frontmatter";

export type PropertyScalar = string | number | boolean | null;
export type PropertyValue = PropertyScalar | PropertyScalar[];
export type PropertyMutation =
  | { kind: "add"; key: string; value: PropertyValue }
  | { kind: "set"; key: string; value: PropertyValue; expected?: unknown }
  | { kind: "rename"; key: string; name: string; expected?: unknown }
  | { kind: "remove"; key: string; expected?: unknown };
export type PropertyInspection = { ok: true; values: Record<string, unknown> } | { ok: false; error: string };
export type PropertyEdit = { ok: true; from: number; to: number; insert: string } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
function scalar(value: unknown): value is PropertyScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}
export function isEditablePropertyValue(value: unknown): value is PropertyValue {
  return scalar(value) || (Array.isArray(value) && value.every(scalar));
}
function read(text: string) {
  if (/^\ufeff---\r?\n/.test(text)) return fail("BOM-prefixed properties need source editing.");
  const info = getFrontMatterInfo(text);
  if (!info.exists && /^---\r?\n/.test(text)) return fail("Frontmatter is not closed. Edit the YAML source to repair it.");
  const doc = info.exists && info.frontmatter.trim() ? parseDocument(info.frontmatter) : new Document({});
  if (doc.errors.length || !isMap(doc.contents)) return fail("Properties need valid YAML with unique keys and a mapping root. Edit the YAML source to repair it.");
  if (doc.contents.items.some(pair => !isScalar(pair.key) || typeof pair.key.value !== "string" || !pair.key.value.trim())) return fail("Property names must be nonempty text. Edit the YAML source to repair them.");
  const values: Record<string, unknown> = Object.create(null);
  const parsed = doc.toJS() as Record<string, unknown>;
  for (const key of Object.keys(parsed)) values[key] = parsed[key];
  return { ok: true as const, doc, map: doc.contents, values, info };
}
export function inspectProperties(text: string): PropertyInspection {
  try { const result = read(text); return result.ok ? { ok: true, values: result.values } : result; }
  catch { return fail("Could not read these properties. Edit the YAML source to repair them."); }
}
export function parsePropertyNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Apply one operation to fresh YAML; unrelated keys and all body bytes survive. */
export function mutateProperty(text: string, operation: PropertyMutation): PropertyEdit {
  try {
    const current = read(text);
    if (!current.ok) return current;
    const { doc, map, info, values } = current;
    const key = operation.kind === "add" ? operation.key.trim() : operation.key;
    if (!key.trim()) return fail("Enter a property name.");
    const exists = Object.hasOwn(values, key);
    if (operation.kind === "add") {
      if (exists) return fail("A property with this name already exists.");
      if (!isEditablePropertyValue(operation.value)) return fail("This value needs source editing.");
      doc.set(key, operation.value);
    } else {
      if (!exists) return fail("This property changed. Refresh the field before editing it.");
      if (!isEditablePropertyValue(values[key])) return fail("Nested values need source editing.");
      if ("expected" in operation && JSON.stringify(operation.expected) !== JSON.stringify(values[key])) return fail("This property changed while you were editing it. Refresh the field and try again.");
      if (operation.kind === "set") {
        if (!isEditablePropertyValue(operation.value)) return fail("This value needs source editing.");
        doc.set(key, operation.value);
      } else if (operation.kind === "remove") {
        const pair = map.items.find(pair => isScalar(pair.key) && pair.key.value === key);
        const comment = pair && isScalar(pair.key) ? pair.key.commentBefore : undefined;
        if (comment) map.commentBefore = [map.commentBefore, comment].filter(Boolean).join("\n");
        doc.delete(key);
      }
      else {
        const name = operation.name.trim();
        if (!name) return fail("Enter a property name.");
        if (name !== key && Object.hasOwn(values, name)) return fail("A property with this name already exists.");
        const pair = map.items.find(pair => isScalar(pair.key) && pair.key.value === key);
        if (!pair || !isScalar(pair.key)) return fail("This property changed.");
        pair.key.value = name;
      }
    }
    const ending = text.includes("\r\n") ? "\r\n" : "\n";
    const yaml = doc.toString().replace(/\r?\n/g, ending);
    const insert = map.items.length || yaml.includes("#") ? `---${ending}${yaml}---${ending}` : "";
    return { ok: true, from: 0, to: info.exists ? info.contentStart : 0, insert };
  } catch { return fail("Could not update these properties. The source was preserved."); }
}
