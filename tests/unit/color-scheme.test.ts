import { describe, expect, it } from "vitest";
import { normalizeThemeSetting, resolveTheme } from "../../src/renderer/color-scheme";

describe("resolveTheme", () => {
  it("auto follows the OS", () => {
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
  });
  it("explicit values ignore the OS", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
  it("treats Obsidian's system like auto and unknown values as dark", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("bogus", false)).toBe("dark");
  });
});

describe("normalizeThemeSetting", () => {
  it("keeps canonical values", () => {
    expect(normalizeThemeSetting("auto", "dark")).toBe("auto");
    expect(normalizeThemeSetting("light", "dark")).toBe("light");
    expect(normalizeThemeSetting("dark", "light")).toBe("dark");
  });
  it("normalizes Obsidian's system to auto", () => {
    expect(normalizeThemeSetting("system", "dark")).toBe("auto");
  });
  it("falls back for legacy, unknown, and missing values", () => {
    expect(normalizeThemeSetting("obsidian", "dark")).toBe("dark");
    expect(normalizeThemeSetting(undefined, "light")).toBe("light");
    expect(normalizeThemeSetting(42, "dark")).toBe("dark");
  });
});
