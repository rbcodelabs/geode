import { describe, expect, it } from "vitest";
import { ForceSimulation } from "../../src/renderer/graph/layout";
import type { GraphEdge, GraphNode } from "../../src/renderer/graph/graph-data";

function node(id: string, x: number, y: number): GraphNode {
  return { id, label: id, degree: 0, x, y, vx: 0, vy: 0 };
}

function dist(a: GraphNode, b: GraphNode): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe("ForceSimulation", () => {
  it("pulls a linked pair of far-apart nodes closer together over time", () => {
    const a = node("A", -400, 0);
    const b = node("B", 400, 0);
    const edges: GraphEdge[] = [{ source: "A", target: "B", weight: 1 }];
    const sim = new ForceSimulation([a, b], edges);
    const startDist = dist(a, b);
    for (let i = 0; i < 200; i++) sim.tick();
    expect(dist(a, b)).toBeLessThan(startDist);
  });

  it("pushes two unlinked overlapping nodes apart via repulsion", () => {
    const a = node("A", 0, 0);
    const b = node("B", 1, 0);
    const sim = new ForceSimulation([a, b], []);
    for (let i = 0; i < 50; i++) sim.tick();
    expect(dist(a, b)).toBeGreaterThan(1);
  });

  it("settles a small linked graph into isSettled() within a bounded number of ticks, after actually moving", () => {
    const a = node("A", -50, 0);
    const b = node("B", 50, 0);
    const edges: GraphEdge[] = [{ source: "A", target: "B", weight: 1 }];
    const sim = new ForceSimulation([a, b], edges);
    let ticks = 0;
    do {
      sim.tick();
      ticks++;
    } while (!sim.isSettled() && ticks < 1000);
    expect(sim.isSettled()).toBe(true);
    expect(ticks).toBeGreaterThan(1); // didn't just report "settled" trivially on tick 0's zero velocity
    expect(ticks).toBeLessThan(1000);
  });

  it("converges a linked pair's separation to roughly linkDistance once settled", () => {
    const a = node("A", -300, 0);
    const b = node("B", 300, 0);
    const linkDistance = 90;
    const sim = new ForceSimulation([a, b], [{ source: "A", target: "B", weight: 1 }], {
      linkDistance,
    });
    let ticks = 0;
    do {
      sim.tick();
      ticks++;
    } while (!sim.isSettled() && ticks < 1000);
    // Repulsion pushes the pair slightly past the spring's rest length at
    // equilibrium, so allow some tolerance rather than an exact match.
    expect(dist(a, b)).toBeGreaterThan(linkDistance * 0.5);
    expect(dist(a, b)).toBeLessThan(linkDistance * 2);
  });

  it("keeps positions finite (no NaN/Infinity blowup) even for coincident starting nodes", () => {
    const a = node("A", 0, 0);
    const b = node("B", 0, 0);
    const c = node("C", 0, 0);
    const sim = new ForceSimulation([a, b, c], []);
    for (let i = 0; i < 100; i++) sim.tick();
    for (const n of [a, b, c]) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("ignores an edge referencing an id that isn't in the node list, without throwing", () => {
    const a = node("A", 0, 0);
    const sim = new ForceSimulation([a], [{ source: "A", target: "Ghost", weight: 1 }]);
    expect(() => sim.tick()).not.toThrow();
  });
});
