import type { GraphEdge, GraphNode } from "./graph-data";

export interface ForceOptions {
  /** Pairwise repulsion strength (all nodes push each other apart). */
  repelStrength: number;
  /** Spring rest length for linked node pairs. */
  linkDistance: number;
  /** Spring stiffness pulling linked nodes toward `linkDistance` apart. */
  linkStrength: number;
  /** Weak pull of every node toward the origin, to stop the whole graph from drifting. */
  centerStrength: number;
  /** Velocity multiplier applied each tick (< 1 bleeds off energy so the layout settles). */
  damping: number;
  /** Distance floor used when computing repulsion, to avoid a division blowup at ~0 distance. */
  minDistance: number;
}

const DEFAULT_OPTIONS: ForceOptions = {
  repelStrength: 1800,
  linkDistance: 90,
  linkStrength: 0.08,
  centerStrength: 0.01,
  damping: 0.85,
  minDistance: 20,
};

/**
 * Minimal O(n^2) force-directed layout: pairwise repulsion, spring-based
 * link attraction, and a weak centering pull. No spatial partitioning
 * (Barnes-Hut, quadtree, etc.) — fine at vault scale (hundreds of notes,
 * not tens of thousands), matching the same complexity class as
 * `MetadataCache.resolveAll()`'s own full rebuild. Pure math, no DOM/Canvas
 * dependency, so it's unit-testable without mocking a rendering context.
 */
export class ForceSimulation {
  private options: ForceOptions;
  private byId: Map<string, GraphNode>;

  constructor(
    private nodes: GraphNode[],
    private edges: GraphEdge[],
    options: Partial<ForceOptions> = {}
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.byId = new Map(nodes.map((n) => [n.id, n]));
  }

  /** Advance the simulation by one step, mutating node positions/velocities in place. */
  tick(): void {
    const { repelStrength, linkDistance, linkStrength, centerStrength, damping, minDistance } =
      this.options;
    const n = this.nodes.length;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = this.nodes[i];
        const b = this.nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        if (dx === 0 && dy === 0) {
          // Coincident nodes: nudge apart deterministically (no Math.random
          // dependency, and stable across repeated ticks).
          dx = ((i - j) % 7) - 3 || 1;
          dy = ((i + j) % 5) - 2 || 1;
        }
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), minDistance);
        const force = repelStrength / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    for (const edge of this.edges) {
      const a = this.byId.get(edge.source);
      const b = this.byId.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const force = (dist - linkDistance) * linkStrength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    for (const node of this.nodes) {
      node.vx += -node.x * centerStrength;
      node.vy += -node.y * centerStrength;
      node.vx *= damping;
      node.vy *= damping;
      node.x += node.vx;
      node.y += node.vy;
    }
  }

  /**
   * True once average kinetic energy per node drops below a small
   * threshold — the layout has settled. Every node starts at rest
   * (`vx`/`vy` = 0), so this is trivially true *before* `tick()` has ever
   * run once. Callers driving a "tick until settled" loop must run at
   * least one `tick()` unconditionally before checking this, or the
   * simulation never moves at all.
   */
  isSettled(threshold = 0.05): boolean {
    let energy = 0;
    for (const node of this.nodes) energy += node.vx * node.vx + node.vy * node.vy;
    return energy / Math.max(this.nodes.length, 1) < threshold * threshold;
  }
}
