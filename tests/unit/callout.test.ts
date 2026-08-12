import { describe, expect, it } from "vitest";
import {
  calloutMarkerLength,
  calloutMeta,
  defaultCalloutTitle,
  parseCalloutHeader,
} from "../../src/renderer/markdown/callout";

describe("parseCalloutHeader (Obsidian `[!type]` blockquote marker)", () => {
  it("extracts type and title from a simple callout header", () => {
    expect(parseCalloutHeader("[!tip] Useful hint")).toEqual({
      type: "tip",
      fold: "",
      title: "Useful hint",
      raw: "[!tip] Useful hint",
    });
  });

  it("lowercases the type", () => {
    expect(parseCalloutHeader("[!TIP] Shout")).toMatchObject({ type: "tip" });
  });

  it("defaults to an empty title when none is given", () => {
    expect(parseCalloutHeader("[!note]")).toMatchObject({ type: "note", title: "" });
  });

  it("parses the fold marker (+ expanded, - collapsed)", () => {
    expect(parseCalloutHeader("[!warning]- Collapsed by default")).toMatchObject({
      type: "warning",
      fold: "-",
      title: "Collapsed by default",
    });
    expect(parseCalloutHeader("[!warning]+ Expanded")).toMatchObject({ fold: "+" });
    expect(parseCalloutHeader("[!warning] No fold")).toMatchObject({ fold: "" });
  });

  it("trims surrounding whitespace from the title", () => {
    expect(parseCalloutHeader("[!info]   spaced out   ")).toMatchObject({ title: "spaced out" });
  });

  it("returns null for text that isn't a callout marker", () => {
    expect(parseCalloutHeader("just a regular blockquote")).toBeNull();
    expect(parseCalloutHeader("")).toBeNull();
  });
});

describe("calloutMeta (icon + CSS class lookup)", () => {
  it("maps known types to a canonical CSS class and Lucide icon id", () => {
    expect(calloutMeta("tip")).toEqual({ cssClass: "tip", icon: "flame" });
    expect(calloutMeta("warning")).toEqual({ cssClass: "warning", icon: "alert-triangle" });
    expect(calloutMeta("danger")).toEqual({ cssClass: "danger", icon: "zap" });
  });

  it("resolves aliases to their canonical type", () => {
    expect(calloutMeta("hint")).toEqual(calloutMeta("tip"));
    expect(calloutMeta("caution")).toEqual(calloutMeta("warning"));
    expect(calloutMeta("error")).toEqual(calloutMeta("danger"));
    expect(calloutMeta("cite")).toEqual(calloutMeta("quote"));
  });

  it("covers every callout family from the brief", () => {
    for (const type of [
      "note", "tip", "warning", "danger", "info", "success",
      "question", "quote", "example", "bug", "todo", "abstract", "failure",
    ]) {
      const meta = calloutMeta(type);
      expect(meta.cssClass, type).toBe(type);
      expect(meta.icon, type).toBeTypeOf("string");
      expect(meta.icon.length, type).toBeGreaterThan(0);
    }
  });

  it("falls back to the note styling for an unrecognized custom type", () => {
    expect(calloutMeta("my-custom-type")).toEqual(calloutMeta("note"));
  });
});

describe("calloutMarkerLength (Live Preview: marker+fold only, excluding the title)", () => {
  it("measures the `[!type] ` marker so the title text stays untouched", () => {
    expect(calloutMarkerLength("[!tip] Useful hint")).toBe("[!tip] ".length);
    expect(calloutMarkerLength("[!warning]- Collapsed")).toBe("[!warning]- ".length);
    expect(calloutMarkerLength("[!note]")).toBe("[!note]".length);
  });

  it("returns null for non-callout text", () => {
    expect(calloutMarkerLength("no marker here")).toBeNull();
  });
});

describe("defaultCalloutTitle", () => {
  it("capitalizes the type when no explicit title is given", () => {
    expect(defaultCalloutTitle("tip")).toBe("Tip");
    expect(defaultCalloutTitle("warning")).toBe("Warning");
  });
});
