import { describe, expect, it } from "vitest";
import {
  isExternalHref,
  shouldInterceptAnchor,
  type AnchorSnapshot,
} from "../../src/renderer/external-links";

/** Build an AnchorSnapshot with sane defaults; override per case. */
function snap(partial: Partial<AnchorSnapshot>): AnchorSnapshot {
  return {
    rawHref: null,
    resolvedHref: null,
    classes: [],
    hasDataHref: false,
    ...partial,
  };
}

describe("isExternalHref", () => {
  it("treats http(s) URLs as external", () => {
    expect(isExternalHref("https://example.com")).toBe(true);
    expect(isExternalHref("http://example.com/path?q=1")).toBe(true);
    expect(isExternalHref("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  it("treats mailto: as external", () => {
    expect(isExternalHref("mailto:someone@example.com")).toBe(true);
  });

  it("treats internal / relative / hash / other-scheme hrefs as not external", () => {
    expect(isExternalHref("#heading")).toBe(false);
    expect(isExternalHref("note.md")).toBe(false);
    expect(isExternalHref("Projects/Roadmap")).toBe(false);
    expect(isExternalHref("app://obsidian.md/index.html")).toBe(false);
    expect(isExternalHref("file:///Users/x/vault/note.md")).toBe(false);
    expect(isExternalHref("javascript:alert(1)")).toBe(false);
  });

  it("returns false for empty / null / undefined", () => {
    expect(isExternalHref("")).toBe(false);
    expect(isExternalHref("   ")).toBe(false);
    expect(isExternalHref(null)).toBe(false);
    expect(isExternalHref(undefined)).toBe(false);
  });
});

describe("shouldInterceptAnchor", () => {
  it("intercepts a plain external http(s) anchor (the plugin-content bug case)", () => {
    expect(
      shouldInterceptAnchor(
        snap({ rawHref: "https://example.com", resolvedHref: "https://example.com/" })
      )
    ).toBe(true);
  });

  it("intercepts a mailto anchor", () => {
    expect(
      shouldInterceptAnchor(
        snap({ rawHref: "mailto:x@y.com", resolvedHref: "mailto:x@y.com" })
      )
    ).toBe(true);
  });

  it("skips Live Preview external links (cm-live-extlink)", () => {
    expect(
      shouldInterceptAnchor(
        snap({ rawHref: "https://example.com", resolvedHref: "https://example.com/", classes: ["cm-live-extlink"] })
      )
    ).toBe(false);
  });

  it("skips Live Preview wikilinks (cm-live-wikilink)", () => {
    expect(
      shouldInterceptAnchor(snap({ rawHref: "#", classes: ["cm-live-wikilink"], hasDataHref: true }))
    ).toBe(false);
  });

  it("skips rendered-Markdown internal links and tags", () => {
    expect(
      shouldInterceptAnchor(snap({ rawHref: "#", classes: ["internal-link"], hasDataHref: true }))
    ).toBe(false);
    expect(
      shouldInterceptAnchor(snap({ rawHref: "#", classes: ["tag"], hasDataHref: true }))
    ).toBe(false);
  });

  it("skips any anchor carrying data-href even without a known class", () => {
    expect(
      shouldInterceptAnchor(snap({ rawHref: "https://example.com", resolvedHref: "https://example.com/", hasDataHref: true }))
    ).toBe(false);
  });

  it("skips same-document hash and empty anchors", () => {
    expect(shouldInterceptAnchor(snap({ rawHref: "#" }))).toBe(false);
    expect(shouldInterceptAnchor(snap({ rawHref: "#section" }))).toBe(false);
    expect(shouldInterceptAnchor(snap({ rawHref: "" }))).toBe(false);
    expect(shouldInterceptAnchor(snap({ rawHref: null }))).toBe(false);
  });

  it("skips a relative path (resolved to an internal app:// URL)", () => {
    // A bare relative anchor resolves to an app://-scheme URL in the renderer;
    // it is internal, so it must not be sent to the external handler.
    expect(
      shouldInterceptAnchor(
        snap({ rawHref: "note.md", resolvedHref: "app://obsidian.md/note.md" })
      )
    ).toBe(false);
  });
});
