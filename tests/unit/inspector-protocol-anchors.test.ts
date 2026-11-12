import { describe, expect, it } from "vitest";
import { INSPECT_CHANNEL, INSPECT_GUEST_TO_EMBEDDER_CHANNELS } from "../../src/artifacts/inspector-protocol";

describe("inspect:v1 anchor channels (ADR 0006 addendum 2, A.4)", () => {
  it("uses the documented names", () => {
    expect(INSPECT_CHANNEL.anchors).toBe("geode-artifact:inspect:v1:anchors");
    expect(INSPECT_CHANNEL.anchorFocus).toBe("geode-artifact:inspect:v1:anchor-focus");
    expect(INSPECT_CHANNEL.anchorResults).toBe("geode-artifact:inspect:v1:anchor-results");
    expect(INSPECT_CHANNEL.anchorRects).toBe("geode-artifact:inspect:v1:anchor-rects");
  });

  it("lists the two guest-to-embedder channels (and not the embedder-to-guest ones) as guest channels", () => {
    expect(INSPECT_GUEST_TO_EMBEDDER_CHANNELS).toContain(INSPECT_CHANNEL.anchorResults);
    expect(INSPECT_GUEST_TO_EMBEDDER_CHANNELS).toContain(INSPECT_CHANNEL.anchorRects);
    expect(INSPECT_GUEST_TO_EMBEDDER_CHANNELS).not.toContain(INSPECT_CHANNEL.anchors);
    expect(INSPECT_GUEST_TO_EMBEDDER_CHANNELS).not.toContain(INSPECT_CHANNEL.anchorFocus);
  });

  it("keeps the v1 channels exactly as they were", () => {
    expect(INSPECT_GUEST_TO_EMBEDDER_CHANNELS.slice(0, 5)).toEqual([
      "geode-artifact:inspect:v1:ready",
      "geode-artifact:inspect:v1:hover",
      "geode-artifact:inspect:v1:select",
      "geode-artifact:inspect:v1:cancel",
      "geode-artifact:inspect:v1:rect",
    ]);
  });
});
