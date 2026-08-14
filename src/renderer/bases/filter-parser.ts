import { FilterNode } from "./ast";
import { parseExpression } from "./parser";

/**
 * Walk a YAML-parsed JS value shaped like the `filters` block of a `.base`
 * file — `{and: [...]} | {or: [...]} | {not: [...]} | "leaf expression"` —
 * recursively, parsing every leaf string with `parseExpression`.
 *
 * Never throws. Returns `{error}` for a structurally invalid filter node
 * (wrong shape) or if any leaf expression fails to parse.
 */
export function parseFilterTree(yamlNode: unknown): { tree: FilterNode } | { error: string } {
  if (typeof yamlNode === "string") {
    const parsed = parseExpression(yamlNode);
    if ("error" in parsed) return { error: `In filter "${yamlNode}": ${parsed.error}` };
    return { tree: { leaf: parsed.expr } };
  }

  if (yamlNode && typeof yamlNode === "object" && !Array.isArray(yamlNode)) {
    const obj = yamlNode as Record<string, unknown>;
    for (const key of ["and", "or", "not"] as const) {
      if (key in obj) {
        const children = obj[key];
        if (!Array.isArray(children)) {
          return { error: `Filter "${key}" must be a list of conditions` };
        }
        const parsedChildren: FilterNode[] = [];
        for (const child of children) {
          const result = parseFilterTree(child);
          if ("error" in result) return result;
          parsedChildren.push(result.tree);
        }
        return { tree: { [key]: parsedChildren } as FilterNode };
      }
    }
    return { error: `Filter object must have an "and", "or", or "not" key` };
  }

  return { error: `Unrecognized filter node: ${JSON.stringify(yamlNode)}` };
}
