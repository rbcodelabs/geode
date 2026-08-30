import { describe, expect, it, vi } from "vitest";
import { CanvasTouchGesture } from "../../src/renderer/canvas/touch-gesture";

const point = (pointerId: number, x: number, y: number) => ({ pointerId, x, y });

function fixture(selected = true) {
  const callbacks = {
    hitTest: vi.fn(() => "a" as string | null),
    canDrag: vi.fn(() => selected),
    select: vi.fn(), beginNodeDrag: vi.fn(), moveNode: vi.fn(), commitNode: vi.fn(), rollbackNode: vi.fn(),
    pan: vi.fn(), zoom: vi.fn(),
  };
  return { callbacks, gesture: new CanvasTouchGesture(callbacks) };
}

describe("CanvasTouchGesture", () => {
  it("taps to select and crosses the threshold before moving a selected node", () => {
    const { callbacks, gesture } = fixture();
    gesture.down(point(1, 10, 10));
    gesture.move(point(1, 13, 13));
    expect(callbacks.beginNodeDrag).not.toHaveBeenCalled();
    gesture.move(point(1, 22, 16));
    expect(callbacks.beginNodeDrag).toHaveBeenCalledWith("a");
    expect(callbacks.moveNode).toHaveBeenLastCalledWith("a", 12, 6);
    gesture.up(point(1, 22, 16));
    expect(callbacks.commitNode).toHaveBeenCalledWith("a");
    expect(callbacks.select).not.toHaveBeenCalled();
  });

  it("does not drag an unselected node on its selection tap", () => {
    const { callbacks, gesture } = fixture(false);
    gesture.down(point(1, 10, 10));
    gesture.move(point(1, 30, 10));
    gesture.up(point(1, 30, 10));
    expect(callbacks.beginNodeDrag).not.toHaveBeenCalled();
    expect(callbacks.select).toHaveBeenCalledWith("a");
  });

  it("rolls back a node drag when a second pointer transitions to viewport pinch", () => {
    const { callbacks, gesture } = fixture();
    gesture.down(point(1, 0, 0));
    gesture.move(point(1, 12, 0));
    gesture.down(point(2, 20, 0));
    expect(callbacks.rollbackNode).toHaveBeenCalledWith("a");
    gesture.move(point(1, -5, 5));
    gesture.move(point(2, 25, 5));
    expect(callbacks.pan).toHaveBeenCalled();
    expect(callbacks.zoom).toHaveBeenCalled();
    gesture.up(point(1, -5, 5));
    gesture.up(point(2, 25, 5));
    expect(callbacks.commitNode).not.toHaveBeenCalled();
  });

  it("cancellation rolls back source geometry while finish commits it once", () => {
    const cancelled = fixture();
    cancelled.gesture.down(point(1, 0, 0));
    cancelled.gesture.move(point(1, 20, 0));
    cancelled.gesture.cancel();
    expect(cancelled.callbacks.rollbackNode).toHaveBeenCalledTimes(1);
    expect(cancelled.gesture.pointerIds()).toEqual([]);

    const finished = fixture();
    finished.gesture.down(point(1, 0, 0));
    finished.gesture.move(point(1, 20, 0));
    finished.gesture.finish();
    expect(finished.callbacks.commitNode).toHaveBeenCalledTimes(1);
    expect(finished.callbacks.rollbackNode).not.toHaveBeenCalled();
  });
});
