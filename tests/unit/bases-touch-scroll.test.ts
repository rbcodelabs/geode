import { describe, expect, it } from "vitest";
import { resolveTouchScrollAxis } from "../../src/renderer/bases/touch-scroll";

describe("Bases touch scroll arbitration", () => {
  it("stays pending below the drag threshold", () => {
    expect(resolveTouchScrollAxis(3, 4)).toBe("pending");
  });

  it("locks horizontal movement when the horizontal delta dominates", () => {
    expect(resolveTouchScrollAxis(-20, 5)).toBe("x");
    expect(resolveTouchScrollAxis(8, 8)).toBe("x");
  });

  it("locks vertical movement when the vertical delta dominates", () => {
    expect(resolveTouchScrollAxis(4, -20)).toBe("y");
  });
});
