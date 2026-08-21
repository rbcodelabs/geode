import { describe, expect, it } from "vitest";
import { computeAnchoredMenuPosition } from "../../src/renderer/menu-position";

describe("computeAnchoredMenuPosition", () => {
  const viewport = { width: 1000, height: 800 };
  const menu = { width: 200, height: 120 };

  it.each([
    ["top-left", { left: 0, top: 0, right: 24, bottom: 24 }, { left: 8, top: 28 }],
    ["top", { left: 488, top: 0, right: 512, bottom: 24 }, { left: 312, top: 28 }],
    ["top-right", { left: 976, top: 0, right: 1000, bottom: 24 }, { left: 792, top: 28 }],
    ["left", { left: 0, top: 388, right: 24, bottom: 412 }, { left: 8, top: 416 }],
    ["right", { left: 976, top: 388, right: 1000, bottom: 412 }, { left: 792, top: 416 }],
    ["bottom-left", { left: 0, top: 776, right: 24, bottom: 800 }, { left: 8, top: 652 }],
    ["bottom", { left: 488, top: 776, right: 512, bottom: 800 }, { left: 312, top: 652 }],
    ["bottom-right", { left: 976, top: 776, right: 1000, bottom: 800 }, { left: 792, top: 652 }],
  ])("positions a dropdown at the %s orientation", (_name, anchor, expected) => {
    expect(computeAnchoredMenuPosition({
      anchor,
      menu,
      viewport,
      margin: 8,
      gap: 4,
      horizontalAlign: "end",
    })).toEqual(expected);
  });

  it("preserves the margin when the popup is as large as the usable viewport", () => {
    expect(computeAnchoredMenuPosition({
      anchor: { left: 390, top: 290, right: 414, bottom: 314 },
      menu: { width: 784, height: 584 },
      viewport: { width: 800, height: 600 },
      margin: 8,
      gap: 4,
      horizontalAlign: "end",
    })).toEqual({ left: 8, top: 8 });
  });
});
