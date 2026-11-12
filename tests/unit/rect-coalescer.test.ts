import { describe, expect, it } from "vitest";
import { createRectCoalescer } from "../../src/renderer/artifacts/rect-coalescer";

interface Box { x: number; y: number; width: number; height: number }
function harness() {
  const frames: Array<() => void> = [];
  const applied: Box[] = [];
  const coalescer = createRectCoalescer<Box>({
    schedule: (cb) => { frames.push(cb); return frames.length; },
    cancel: () => { frames.length = 0; },
    apply: (box) => applied.push(box),
  });
  const frame = () => { const run = frames.splice(0); for (const cb of run) cb(); };
  return { coalescer, applied, frame, pending: () => frames.length };
}

describe("createRectCoalescer (at most one embedder update per animation frame, review A3)", () => {
  it("applies only the latest rect once per frame, however many arrive", () => {
    const { coalescer, applied, frame, pending } = harness();
    for (let i = 0; i < 50; i++) coalescer.push({ x: 0, y: i, width: 10, height: 10 });
    expect(pending()).toBe(1);
    expect(applied).toEqual([]);
    frame();
    expect(applied).toEqual([{ x: 0, y: 49, width: 10, height: 10 }]);
  });

  it("never loses the last rect: a push after a frame schedules the next one", () => {
    const { coalescer, applied, frame } = harness();
    coalescer.push({ x: 0, y: 1, width: 1, height: 1 });
    frame();
    coalescer.push({ x: 0, y: 2, width: 1, height: 1 });
    frame();
    expect(applied.map((b) => b.y)).toEqual([1, 2]);
  });

  it("skips a rect that rounds to the one already applied, and tolerates sub-pixel noise", () => {
    const { coalescer, applied, frame } = harness();
    coalescer.push({ x: 10.2, y: 20.4, width: 30.1, height: 40.2 });
    frame();
    coalescer.push({ x: 10.4, y: 20.1, width: 29.9, height: 39.8 });
    frame();
    expect(applied).toHaveLength(1);
    coalescer.push({ x: 11.2, y: 20.4, width: 30.1, height: 40.2 });
    frame();
    expect(applied).toHaveLength(2);
  });

  it("reset forgets the last applied rect (a new selection must apply even an identical rect)", () => {
    const { coalescer, applied, frame } = harness();
    coalescer.push({ x: 1, y: 1, width: 1, height: 1 });
    frame();
    coalescer.reset();
    coalescer.push({ x: 1, y: 1, width: 1, height: 1 });
    frame();
    expect(applied).toHaveLength(2);
  });

  it("dispose cancels a pending frame and ignores later pushes", () => {
    const { coalescer, applied, frame, pending } = harness();
    coalescer.push({ x: 1, y: 1, width: 1, height: 1 });
    coalescer.dispose();
    expect(pending()).toBe(0);
    coalescer.push({ x: 2, y: 2, width: 2, height: 2 });
    frame();
    expect(applied).toEqual([]);
  });

  it("a throwing apply does not wedge the coalescer", () => {
    let calls = 0;
    const frames: Array<() => void> = [];
    const c = createRectCoalescer<Box>({ schedule: (cb) => { frames.push(cb); return 1; }, cancel: () => {}, apply: () => { calls++; if (calls === 1) throw new Error("boom"); } });
    c.push({ x: 1, y: 1, width: 1, height: 1 });
    expect(() => frames.splice(0).forEach((f) => f())).toThrow();
    c.push({ x: 2, y: 2, width: 2, height: 2 });
    frames.splice(0).forEach((f) => f());
    expect(calls).toBe(2);
  });
});
