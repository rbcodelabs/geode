export type CanvasSide = "top" | "right" | "bottom" | "left";
export type CanvasEnd = "none" | "arrow";

interface CanvasNodeBase {
  [key: string]: unknown;
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

export interface CanvasTextNode extends CanvasNodeBase { type: "text"; text: string }
export interface CanvasFileNode extends CanvasNodeBase { type: "file"; file: string; subpath?: string }
export interface CanvasLinkNode extends CanvasNodeBase { type: "link"; url: string }
export interface CanvasGroupNode extends CanvasNodeBase { type: "group"; label?: string; background?: string; backgroundStyle?: "cover" | "ratio" | "repeat" }
export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode;

export interface CanvasEdge {
  [key: string]: unknown;
  id: string;
  fromNode: string;
  fromSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toNode: string;
  toSide?: CanvasSide;
  toEnd?: CanvasEnd;
  color?: string;
  label?: string;
}

export interface CanvasDocument { [key: string]: unknown; nodes: CanvasNode[]; edges: CanvasEdge[] }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function parseNode(value: unknown, index: number): CanvasNode {
  const raw = object(value, `nodes[${index}]`);
  const base = {
    ...raw,
    id: string(raw.id, `nodes[${index}].id`),
    type: string(raw.type, `nodes[${index}].type`),
    x: number(raw.x, `nodes[${index}].x`),
    y: number(raw.y, `nodes[${index}].y`),
    width: number(raw.width, `nodes[${index}].width`),
    height: number(raw.height, `nodes[${index}].height`),
    color: optionalString(raw.color, `nodes[${index}].color`),
  };
  if (base.width <= 0 || base.height <= 0) throw new Error(`nodes[${index}] dimensions must be positive`);
  switch (base.type) {
    case "text": return { ...base, type: "text", text: string(raw.text, `nodes[${index}].text`) };
    case "file": return { ...base, type: "file", file: string(raw.file, `nodes[${index}].file`), subpath: optionalString(raw.subpath, `nodes[${index}].subpath`) };
    case "link": return { ...base, type: "link", url: string(raw.url, `nodes[${index}].url`) };
    case "group": return { ...base, type: "group", label: optionalString(raw.label, `nodes[${index}].label`), background: optionalString(raw.background, `nodes[${index}].background`), backgroundStyle: member(raw.backgroundStyle, new Set(["cover", "ratio", "repeat"]), `nodes[${index}].backgroundStyle`) };
    default: throw new Error(`Unsupported node type: ${base.type}`);
  }
}

const SIDES = new Set(["top", "right", "bottom", "left"]);
const ENDS = new Set(["none", "arrow"]);

function member<T extends string>(value: unknown, allowed: Set<string>, label: string): T | undefined {
  if (value === undefined) return undefined;
  const result = string(value, label);
  if (!allowed.has(result)) throw new Error(`${label} is invalid`);
  return result as T;
}

function parseEdge(value: unknown, index: number): CanvasEdge {
  const raw = object(value, `edges[${index}]`);
  return {
    ...raw,
    id: string(raw.id, `edges[${index}].id`),
    fromNode: string(raw.fromNode, `edges[${index}].fromNode`),
    fromSide: member(raw.fromSide, SIDES, `edges[${index}].fromSide`),
    fromEnd: member(raw.fromEnd, ENDS, `edges[${index}].fromEnd`),
    toNode: string(raw.toNode, `edges[${index}].toNode`),
    toSide: member(raw.toSide, SIDES, `edges[${index}].toSide`),
    toEnd: member(raw.toEnd, ENDS, `edges[${index}].toEnd`),
    color: optionalString(raw.color, `edges[${index}].color`),
    label: optionalString(raw.label, `edges[${index}].label`),
  };
}

export function parseCanvas(source: string): CanvasDocument {
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) { throw new Error(`Invalid JSON Canvas: ${(error as Error).message}`); }
  const raw = object(value, "Canvas");
  const rawNodes = raw.nodes ?? [];
  const rawEdges = raw.edges ?? [];
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) throw new Error("Canvas nodes and edges must be arrays");
  const nodes = rawNodes.map(parseNode);
  const edges = rawEdges.map(parseEdge);
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) throw new Error(`Duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode)) throw new Error(`Edge ${edge.id} references a missing node`);
  }
  return { ...raw, nodes, edges };
}

/**
 * Build the content Search indexes for a JSON Canvas without exposing JSON
 * syntax, geometry, IDs, colors, or vendor extension fields as false hits.
 * Invalid documents have no semantic content rather than falling back to raw
 * JSON, so malformed files cannot fabricate search results.
 */
export function projectCanvasForSearch(source: string): string | null {
  let canvas: CanvasDocument;
  try {
    canvas = parseCanvas(source);
  } catch {
    return null;
  }
  const values: string[] = [];
  for (const node of canvas.nodes) {
    if (node.type === "text") values.push(node.text);
    else if (node.type === "file") values.push(node.file + (node.subpath ?? ""));
    else if (node.type === "link") values.push(node.url);
    else {
      if (node.label) values.push(node.label);
      if (node.background) values.push(node.background);
    }
  }
  for (const edge of canvas.edges) {
    if (edge.label) values.push(edge.label);
  }
  return values.join("\n");
}

export interface CanvasFileLinkProjection {
  link: string;
  context: string;
}

/**
 * Project file cards for MetadataCache without interpreting text-card
 * Markdown or exposing raw JSON as backlink context. Resolution remains the
 * cache's responsibility because only targets that resolve to Markdown notes
 * are backlinks; this helper deliberately preserves every file-card target.
 */
export function projectCanvasFileLinks(source: string): CanvasFileLinkProjection[] | null {
  let canvas: CanvasDocument;
  try {
    canvas = parseCanvas(source);
  } catch {
    return null;
  }
  return canvas.nodes
    .filter((node): node is CanvasFileNode => node.type === "file")
    .map((node) => {
      const link = node.file + (node.subpath ?? "");
      return { link, context: `Note card: ${link}` };
    });
}

export function serializeCanvas(canvas: CanvasDocument): string {
  return JSON.stringify(canvas, null, 2) + "\n";
}
