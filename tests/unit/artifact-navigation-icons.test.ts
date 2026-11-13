import { describe, expect, it } from "vitest";
import { getIconSvg } from "../../src/renderer/api/icons";

// The toolbar names its icons as strings; an unknown id renders an empty button, so pin the three it uses.
describe("artifact navigation toolbar icons", () => {
  it.each(["arrow-left", "arrow-right", "house"])("%s resolves to a real Lucide SVG", (id) => {
    expect(getIconSvg(id)).toMatch(/<svg/);
  });
});
