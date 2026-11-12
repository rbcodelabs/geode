import { describe, expect, it, vi } from "vitest";
import { createAnchorProbe } from "../../src/renderer/artifacts/anchor-probe";

describe("anchor probe test hook", () => {
  it("passes setAnchors/focus through and records validated messages, keeping the last 50", () => {
    const bridge = { anchorEpoch: 3, setAnchors: vi.fn(() => ({ epoch: 3, sent: 0, rejected: [] })), focusAnchor: vi.fn(() => true) };
    const { probe, onResults, onRects } = createAnchorProbe(bridge);
    expect(probe.setAnchors([])).toEqual({ epoch: 3, sent: 0, rejected: [] });
    expect(probe.focus("a0", "flash")).toBe(true);
    expect(bridge.focusAnchor).toHaveBeenCalledWith("a0", "flash");
    for (let i = 0; i < 60; i++) onResults({ epoch: 3, results: [] });
    onRects({ epoch: 3, rects: [] });
    const snap = probe.snapshot();
    expect(snap).toMatchObject({ epoch: 3, resultCount: 60, rectCount: 1 });
    expect(snap.results).toHaveLength(50);
    probe.clear();
    expect(probe.snapshot()).toMatchObject({ resultCount: 0, rectCount: 0, results: [], rects: [] });
  });
});
