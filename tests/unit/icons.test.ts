import { describe, expect, it } from "vitest";
import { addIcon, getIconSvg, hasIcon } from "../../src/renderer/api/icons";

describe("icon resolution (Lucide)", () => {
  it("resolves kebab-case Lucide names to an <svg> (the icons Claude Threads uses)", () => {
    for (const name of [
      "message-square",
      "layout-dashboard",
      "git-pull-request",
      "git-branch",
      "clock",
      "globe",
      "puzzle",
      "repeat",
      "smartphone",
    ]) {
      const svg = getIconSvg(name);
      expect(svg, name).toBeTypeOf("string");
      expect(svg!.includes("<svg"), name).toBe(true);
      expect(svg!.includes(`lucide-${name}`), name).toBe(true);
    }
  });

  it("resolves Geode's own built-in view icon names", () => {
    for (const name of ["folder-closed", "search", "link", "list", "tags", "git-fork", "file", "file-text"]) {
      expect(hasIcon(name), name).toBe(true);
    }
  });

  it("returns null for an emoji or unknown id (so callers can fall back to text)", () => {
    expect(getIconSvg("📁")).toBeNull();
    expect(getIconSvg("not-a-real-icon-xyz")).toBeNull();
    expect(hasIcon("🔗")).toBe(false);
  });

  it("prefers a custom icon registered via addIcon()", () => {
    addIcon("my-custom-icon", "<svg data-custom>x</svg>");
    expect(getIconSvg("my-custom-icon")).toBe("<svg data-custom>x</svg>");
  });
});
