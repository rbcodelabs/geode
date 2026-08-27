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

  // Vitest runs these unit tests under `environment: "node"` (no jsdom/
  // happy-dom installed), so nothing about `innerHTML` injection or actual
  // rendering (setIcon's DOM side effects, computed styles, getBBox) is
  // unit-testable here. Those are covered end-to-end instead, in
  // tests/e2e/plugin-api-compat.spec.ts, against a real Electron/Chromium
  // window. What IS unit-testable, and covered below, is the string-level
  // contract addIcon/getIconSvg normalize to.

  it("addIcon wraps a bare fragment in a complete <svg viewBox> with svg-icon + id classes", () => {
    addIcon("bare-fragment-icon", '<path fill="currentColor" d="M0 0 L1 1" />');
    const svg = getIconSvg("bare-fragment-icon");
    expect(svg).toBe(
      '<svg viewBox="0 0 100 100" class="svg-icon bare-fragment-icon">' +
        '<path fill="currentColor" d="M0 0 L1 1" />' +
        "</svg>"
    );
  });

  it("addIcon passes a complete <svg> element through verbatim (no double-wrapping)", () => {
    addIcon("full-svg-icon", '<svg viewBox="0 0 24 24"><circle r="1" /></svg>');
    expect(getIconSvg("full-svg-icon")).toBe('<svg viewBox="0 0 24 24"><circle r="1" /></svg>');
  });

  it("resolves both the bare and lucide-prefixed spelling of the same icon identically", () => {
    expect(getIconSvg("lucide-search")).toBe(getIconSvg("search"));
    expect(getIconSvg("lucide-search")).not.toBeNull();
  });

  it("does not invent an icon: stripping the lucide- prefix from an unknown id still returns null", () => {
    expect(getIconSvg("lucide-not-a-real-icon-xyz")).toBeNull();
    // A custom icon that happens to be registered under a "lucide-"-prefixed
    // id is NOT reachable by stripping the prefix — the custom map is keyed
    // by exact id, matching Obsidian (no fuzzy custom-icon resolution).
    addIcon("lucide-my-custom", "<svg data-custom-2>y</svg>");
    expect(getIconSvg("my-custom")).toBeNull();
  });
});
