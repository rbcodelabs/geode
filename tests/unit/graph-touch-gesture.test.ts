import { describe, expect, it, vi } from "vitest";
import {
  clampGraphScale,
  findNearestGraphTouchTarget,
  GraphTouchGesture,
} from "../../src/renderer/graph/touch-gesture";

const point = (pointerId: number, x: number, y: number, time = 0) => ({ pointerId, x, y, time });

describe("GraphTouchGesture", () => {
  it("clamps zoom to the supported camera bounds", () => {
    expect(clampGraphScale(0.001)).toBe(0.1);
    expect(clampGraphScale(99)).toBe(8);
    expect(clampGraphScale(2)).toBe(2);
  });
  it("selects on one node tap and opens only on a second timely tap", () => {
    const select = vi.fn();
    const open = vi.fn();
    const gesture = new GraphTouchGesture({ hitTest: () => "Note.md", select, open, pan: vi.fn(), zoom: vi.fn() });
    gesture.down(point(1, 10, 10, 0));
    gesture.up(point(1, 10, 10, 20));
    expect(select).toHaveBeenCalledWith("Note.md");
    expect(open).not.toHaveBeenCalled();
    gesture.down(point(2, 10, 10, 200));
    gesture.up(point(2, 10, 10, 220));
    expect(open).toHaveBeenCalledWith("Note.md");
  });

  it("pans empty space without selecting and treats threshold movement as a drag", () => {
    const pan = vi.fn();
    const select = vi.fn();
    const gesture = new GraphTouchGesture({ hitTest: () => null, select, open: vi.fn(), pan, zoom: vi.fn() });
    gesture.down(point(1, 0, 0));
    gesture.move(point(1, 20, 12));
    gesture.up(point(1, 20, 12));
    expect(pan).toHaveBeenCalledWith(20, 12);
    expect(select).not.toHaveBeenCalled();
  });

  it("pinches around the moving centroid and suppresses node navigation", () => {
    const zoom = vi.fn();
    const pan = vi.fn();
    const open = vi.fn();
    const gesture = new GraphTouchGesture({ hitTest: () => "Note.md", select: vi.fn(), open, pan, zoom });
    gesture.down(point(1, 0, 0));
    gesture.down(point(2, 10, 0));
    gesture.move(point(1, -5, 5));
    gesture.move(point(2, 15, 5));
    expect(zoom).toHaveBeenLastCalledWith(expect.any(Number), 5, 5);
    expect(pan).toHaveBeenCalled();
    gesture.up(point(1, -5, 5));
    gesture.up(point(2, 15, 5));
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["pinch", "cancel", "drag", "empty"] as const)(
    "invalidates a pending second tap after %s",
    (interruption) => {
      const select = vi.fn();
      const open = vi.fn();
      let hit: string | null = "Note.md";
      const gesture = new GraphTouchGesture({ hitTest: () => hit, select, open, pan: vi.fn(), zoom: vi.fn() });
      gesture.down(point(1, 10, 10, 0));
      gesture.up(point(1, 10, 10, 20));

      if (interruption === "pinch") {
        gesture.down(point(2, 0, 0, 100));
        gesture.down(point(3, 20, 0, 100));
        gesture.up(point(2, 0, 0, 120));
        gesture.up(point(3, 20, 0, 120));
      } else if (interruption === "cancel") {
        gesture.down(point(2, 10, 10, 100));
        gesture.cancel();
      } else if (interruption === "drag") {
        gesture.down(point(2, 10, 10, 100));
        gesture.move(point(2, 30, 10, 120));
        gesture.up(point(2, 30, 10, 140));
      } else {
        hit = null;
        gesture.down(point(2, 80, 80, 100));
        gesture.up(point(2, 80, 80, 120));
        hit = "Note.md";
      }

      gesture.down(point(4, 10, 10, 300));
      gesture.up(point(4, 10, 10, 320));
      expect(open).not.toHaveBeenCalled();
      expect(select).toHaveBeenCalledTimes(2);
    }
  );

  it("uses a deterministic 44px touch target without enlarging dense nodes ambiguously", () => {
    const nodes = [
      { id: "B.md", x: 100, y: 100, visualRadius: 3 },
      { id: "A.md", x: 120, y: 100, visualRadius: 18 },
    ];
    expect(findNearestGraphTouchTarget(nodes, 109, 100)?.id).toBe("B.md");
    expect(findNearestGraphTouchTarget(nodes, 110, 100)?.id).toBe("A.md");
    expect(findNearestGraphTouchTarget([{ id: "min.md", x: 50, y: 50, visualRadius: 0.3 }], 71.9, 50)?.id)
      .toBe("min.md");
    expect(findNearestGraphTouchTarget([{ id: "min.md", x: 50, y: 50, visualRadius: 0.3 }], 72.1, 50))
      .toBeNull();
    expect(findNearestGraphTouchTarget([{ id: "max.md", x: 50, y: 50, visualRadius: 128 }], 177.9, 50)?.id)
      .toBe("max.md");
    expect(findNearestGraphTouchTarget([{ id: "max.md", x: 50, y: 50, visualRadius: 128 }], 178.1, 50))
      .toBeNull();
  });

  it("cancels every pointer without emitting selection, open, pan, or zoom", () => {
    const callbacks = { hitTest: () => "Note.md", select: vi.fn(), open: vi.fn(), pan: vi.fn(), zoom: vi.fn() };
    const gesture = new GraphTouchGesture(callbacks);
    gesture.down(point(1, 0, 0));
    gesture.cancel();
    gesture.move(point(1, 20, 20));
    gesture.up(point(1, 20, 20));
    expect(callbacks.select).not.toHaveBeenCalled();
    expect(callbacks.open).not.toHaveBeenCalled();
    expect(callbacks.pan).not.toHaveBeenCalled();
    expect(callbacks.zoom).not.toHaveBeenCalled();
    expect(gesture.pointerIds()).toEqual([]);
  });
});
