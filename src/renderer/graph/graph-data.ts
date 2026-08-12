import type { TFile } from "../types";

export interface GraphNode {
  /** File path — the node's identity. */
  id: string;
  label: string;
  /** Total distinct edges touching this node (in + out), used to size it. */
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Build graph-view nodes/edges from the vault's markdown files and
 * `MetadataCache.resolvedLinks` (source path -> target path -> link count).
 * One node per file; one edge per resolved source->target pair with a
 * target that's also a node (self-links and links to non-markdown/deleted
 * files are skipped). Pure/no-DOM so it's cheaply unit-testable — the
 * `GraphView` owns turning this into pixels.
 */
export function buildGraph(
  files: TFile[],
  resolvedLinks: Map<string, Map<string, number>>
): GraphData {
  const nodeIds = new Set(files.map((f) => f.path));
  const edges: GraphEdge[] = [];
  const degree = new Map<string, number>();
  for (const [source, targets] of resolvedLinks) {
    if (!nodeIds.has(source)) continue;
    for (const [target, weight] of targets) {
      if (target === source) continue; // self-links don't produce an edge
      if (!nodeIds.has(target)) continue;
      edges.push({ source, target, weight });
      degree.set(source, (degree.get(source) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
    }
  }
  const nodes: GraphNode[] = files.map((f, i) => {
    // Deterministic initial layout: evenly spaced on a circle. Starting
    // every node stacked at the origin would leave the repulsion force in
    // layout.ts with a zero-distance singularity on tick 0.
    const angle = (i / Math.max(files.length, 1)) * Math.PI * 2;
    const radius = 200;
    return {
      id: f.path,
      label: f.basename,
      degree: degree.get(f.path) ?? 0,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
  });
  return { nodes, edges };
}
