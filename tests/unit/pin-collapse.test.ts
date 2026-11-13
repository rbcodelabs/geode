import { describe, expect, it } from "vitest";
import {
  PIN_BADGE,
  badgeAnchorPoint,
  collapsePins,
  guestRectToStage,
  intersectsStage,
  type PlacedPin,
} from "../../src/renderer/artifacts/pin-collapse";

const pin = (n: number, x: number, y: number, status: PlacedPin["status"] = "open"): PlacedPin =>
  ({ id: `p${n}`, ordinal: n, status, x, y, approximate: false });

describe("pin-collapse constants (design 3.5)", () => {
  it("uses D=20, merge 22, split 28", () => {
    expect(PIN_BADGE).toMatchObject({ diameter: 20, mergeDistance: 22, splitDistance: 28 });
  });
});

describe("collapsePins: clustering", () => {
  it("renders a lone pin as a numbered badge at its point", () => {
    const { badges } = collapsePins([pin(4, 100, 50)], null);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({ kind: "pin", ids: ["p4"], ordinal: 4, x: 100, y: 50 });
  });

  it("merges two pins closer than 22 px into one count badge at the centroid", () => {
    const { badges } = collapsePins([pin(1, 100, 100), pin(2, 110, 100)], null);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({ kind: "cluster", count: 2, x: 105, y: 100 });
    expect([...badges[0]!.ids].sort()).toEqual(["p1", "p2"]);
  });

  it("keeps pins apart at exactly 22 px from a clean start", () => {
    expect(collapsePins([pin(1, 100, 100), pin(2, 122, 100)], null).badges.map((b) => b.kind)).toEqual(["pin", "pin"]);
  });

  it("merges chains transitively (a-b and b-c close, a-c far)", () => {
    const { badges } = collapsePins([pin(1, 0, 0), pin(2, 20, 0), pin(3, 40, 0)], null);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({ kind: "cluster", count: 3 });
  });

  it("hysteresis: a pair clustered last pass stays merged until 28 px", () => {
    const first = collapsePins([pin(1, 100, 100), pin(2, 110, 100)], null);
    const stillMerged = collapsePins([pin(1, 100, 100), pin(2, 127, 100)], first.assignment);
    expect(stillMerged.badges.map((b) => b.kind)).toEqual(["cluster"]);
    const split = collapsePins([pin(1, 100, 100), pin(2, 128, 100)], stillMerged.assignment);
    expect(split.badges.map((b) => b.kind)).toEqual(["pin", "pin"]);
  });

  it("hysteresis: a pair apart last pass does not merge between 22 and 28 px", () => {
    const first = collapsePins([pin(1, 100, 100), pin(2, 150, 100)], null);
    const next = collapsePins([pin(1, 100, 100), pin(2, 125, 100)], first.assignment);
    expect(next.badges.map((b) => b.kind)).toEqual(["pin", "pin"]);
  });

  it("is stable under tiny moves (1 px jitter never flips a clear decision)", () => {
    const base = [pin(1, 100, 100), pin(2, 108, 104), pin(3, 300, 40), pin(4, 300, 70), pin(5, 500, 500)];
    const first = collapsePins(base, null);
    let previous = first.assignment;
    for (let i = 0; i < 20; i++) {
      const jitter = base.map((p, k) => ({ ...p, x: p.x + ((i + k) % 3) - 1, y: p.y + ((i * 2 + k) % 3) - 1 }));
      const next = collapsePins(jitter, previous);
      expect(next.badges.map((b) => b.key)).toEqual(first.badges.map((b) => b.key));
      previous = next.assignment;
    }
  });

  it("cluster identity is the sorted ids, independent of input order", () => {
    const a = collapsePins([pin(2, 110, 100), pin(1, 100, 100)], null).badges[0]!;
    const b = collapsePins([pin(1, 100, 100), pin(2, 110, 100)], null).badges[0]!;
    expect(a.key).toBe(b.key);
    expect(a.ids).toEqual(["p1", "p2"]);
  });

  it("orders badges in reading order (y, then x)", () => {
    const { badges } = collapsePins([pin(1, 300, 200), pin(2, 100, 200), pin(3, 500, 10)], null);
    expect(badges.map((b) => b.ids[0])).toEqual(["p3", "p2", "p1"]);
  });

  it("z-order: count badges above pins; open above sent above terminal", () => {
    const { badges } = collapsePins([
      pin(1, 0, 0, "resolved"), pin(2, 100, 0, "sent"), pin(3, 200, 0, "open"), pin(4, 300, 0), pin(5, 308, 0),
    ], null);
    const z = (id: string) => badges.find((b) => b.ids.includes(id))!.z;
    expect(z("p3")).toBeGreaterThan(z("p2"));
    expect(z("p2")).toBeGreaterThan(z("p1"));
    expect(z("p4")).toBeGreaterThan(z("p3"));
  });

  it("a cluster carries the most urgent status of its members", () => {
    const { badges } = collapsePins([pin(1, 0, 0, "sent"), pin(2, 5, 0, "open")], null);
    expect(badges[0]).toMatchObject({ kind: "cluster", status: "open" });
  });

  it("returns an assignment mapping every pin id to its cluster key", () => {
    const { assignment, badges } = collapsePins([pin(1, 0, 0), pin(2, 5, 0), pin(3, 400, 0)], null);
    expect(assignment.get("p1")).toBe(assignment.get("p2"));
    expect(assignment.get("p3")).toBe("p3");
    expect(new Set(assignment.values())).toEqual(new Set(badges.map((b) => b.key)));
  });

  it("caps the input at 100 pins", () => {
    const many = Array.from({ length: 140 }, (_, i) => pin(i + 1, i * 40, 0));
    expect(collapsePins(many, null).badges.length).toBeLessThanOrEqual(100);
  });

  it("handles 100 pins fast and without quadratic blowup (generous CI bound)", () => {
    const many = Array.from({ length: 100 }, (_, i) => pin(i + 1, (i % 10) * 15, Math.floor(i / 10) * 15));
    const started = performance.now();
    for (let i = 0; i < 20; i++) collapsePins(many, null);
    expect((performance.now() - started) / 20).toBeLessThan(25);
  });

  it("empty input gives no badges", () => {
    expect(collapsePins([], null)).toMatchObject({ badges: [] });
  });
});

describe("guestRectToStage and badgeAnchorPoint (the one replaceable mapping unit)", () => {
  it("maps a guest viewport rect into stage px by the frame offset plus its border (S2: the webview rect includes the 1 px border)", () => {
    expect(guestRectToStage({ x: 10, y: 20, width: 80, height: 30 }, { left: 40, top: 100, clientLeft: 1, clientTop: 1 }, { left: 30, top: 90 }))
      .toEqual({ x: 21, y: 31, width: 80, height: 30 });
    expect(guestRectToStage({ x: 10, y: 20, width: 80, height: 30 }, { left: 40, top: 100, clientLeft: 0, clientTop: 0 }, { left: 30, top: 90 }))
      .toEqual({ x: 20, y: 30, width: 80, height: 30 });
  });

  it("does not round (sub-pixel rects pass through)", () => {
    expect(guestRectToStage({ x: 10.25, y: 20.5, width: 80.75, height: 30.125 }, { left: 0.5, top: 0.25, clientLeft: 1, clientTop: 1 }, { left: 0, top: 0 }))
      .toEqual({ x: 11.75, y: 21.75, width: 80.75, height: 30.125 });
  });

  it("intersectsStage: a box wholly outside the visible stage does not count as on screen, a partly visible one does", () => {
    const stage = { width: 400, height: 300 };
    expect(intersectsStage({ x: 600, y: 10, width: 50, height: 20 }, stage)).toBe(false);
    expect(intersectsStage({ x: 10, y: 400, width: 50, height: 20 }, stage)).toBe(false);
    expect(intersectsStage({ x: -80, y: 10, width: 50, height: 20 }, stage)).toBe(false);
    expect(intersectsStage({ x: 380, y: 10, width: 50, height: 20 }, stage)).toBe(true);
    expect(intersectsStage({ x: 10, y: 10, width: 0, height: 0 }, stage)).toBe(false);
  });

  it("anchors a badge at the top-right of the element offset (-4, +4)", () => {
    expect(badgeAnchorPoint({ x: 100, y: 200, width: 160, height: 48 }, { width: 900, height: 600 })).toEqual({ x: 256, y: 204 });
  });

  it("clamps the point 2 px inside the stage", () => {
    expect(badgeAnchorPoint({ x: 880, y: -30, width: 100, height: 20 }, { width: 900, height: 600 })).toEqual({ x: 898, y: 2 });
    expect(badgeAnchorPoint({ x: -500, y: 900, width: 10, height: 10 }, { width: 900, height: 600 })).toEqual({ x: 2, y: 598 });
  });

  it("never produces NaN for non-finite input", () => {
    const p = badgeAnchorPoint({ x: Number.NaN, y: Infinity, width: 1, height: 1 }, { width: 900, height: 600 });
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});
