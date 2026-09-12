import { describe, expect, it } from "vitest";
import {
  SANITIZE_FORBIDDEN_TAGS,
  isEventHandlerAttribute,
  isUnsafeUrlAttribute,
} from "../../src/renderer/api/obsidian-dom";

/**
 * `sanitizeHTMLToDom` needs a real `<template>` to parse into, and
 * vitest.config.mts runs the `node` environment (no jsdom) — so the DOM walk
 * itself is exercised by the Electron e2e harness, matching the note in
 * `obsidian-dom-delegation.test.ts`. What these tests pin down is the policy
 * the walk delegates every decision to: which attributes are event handlers,
 * and which URL values carry an executable or content-smuggling scheme.
 *
 * Plugins feed the sanitizer `marked.parse()` output (Claude Threads renders
 * conversation markdown through it), so every vector below is reachable from
 * note content. The app CSP blocks inline handlers today, but that is an
 * unrelated control a popout/webview/custom-protocol page can miss.
 */

/** Control characters spelled by code point, so the source stays plain ASCII. */
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);

describe("isEventHandlerAttribute", () => {
  it("matches inline handlers regardless of case", () => {
    expect(isEventHandlerAttribute("onclick")).toBe(true);
    expect(isEventHandlerAttribute("onerror")).toBe(true);
    expect(isEventHandlerAttribute("OnLoad")).toBe(true);
    expect(isEventHandlerAttribute("ONMOUSEOVER")).toBe(true);
  });

  it("leaves ordinary attributes alone", () => {
    for (const name of ["class", "id", "href", "src", "title", "data-foo", "open"]) {
      expect(isEventHandlerAttribute(name)).toBe(false);
    }
  });
});

describe("isUnsafeUrlAttribute — javascript: scheme", () => {
  it("drops a plain javascript: href", () => {
    expect(isUnsafeUrlAttribute("a", "href", "javascript:alert(1)")).toBe(true);
  });

  it("drops mixed-case obfuscation", () => {
    expect(isUnsafeUrlAttribute("a", "href", "JaVaScRiPt:alert(1)")).toBe(true);
    expect(isUnsafeUrlAttribute("a", "href", "JAVASCRIPT:alert(1)")).toBe(true);
  });

  it("drops schemes padded with leading whitespace and newlines", () => {
    expect(isUnsafeUrlAttribute("a", "href", "  javascript:alert(1)")).toBe(true);
    expect(isUnsafeUrlAttribute("a", "href", LF + "javascript:alert(1)")).toBe(true);
    expect(isUnsafeUrlAttribute("a", "href", CR + LF + " javascript:alert(1)")).toBe(true);
    expect(isUnsafeUrlAttribute("a", "href", NUL + "javascript:alert(1)")).toBe(true);
  });

  it("drops control characters embedded *inside* the scheme", () => {
    // The HTML URL parser discards tab/LF/CR anywhere in the URL, so this
    // navigates in a real browser even though it is not a literal prefix.
    expect(isUnsafeUrlAttribute("a", "href", "java" + TAB + "script:alert(1)")).toBe(true);
    expect(isUnsafeUrlAttribute("a", "href", "java" + LF + "script:alert(1)")).toBe(true);
    expect(isUnsafeUrlAttribute("a", "href", "jav" + CR + "ascript:alert(1)")).toBe(true);
  });

  it("covers every URL-bearing attribute, not just href", () => {
    expect(isUnsafeUrlAttribute("img", "src", "javascript:alert(1)")).toBe(true);
    expect(isUnsafeUrlAttribute("form", "action", "javascript:alert(1)")).toBe(true);
    expect(isUnsafeUrlAttribute("button", "formaction", "javascript:alert(1)")).toBe(true);
    expect(isUnsafeUrlAttribute("a", "xlink:href", "javascript:alert(1)")).toBe(true);
    expect(isUnsafeUrlAttribute("a", "XLink:Href", "javascript:alert(1)")).toBe(true);
  });

  it("drops the legacy vbscript: sibling too", () => {
    expect(isUnsafeUrlAttribute("a", "href", "vbscript:msgbox(1)")).toBe(true);
  });
});

describe("isUnsafeUrlAttribute — data: scheme", () => {
  it("drops data: URLs that navigate to attacker-authored markup", () => {
    expect(isUnsafeUrlAttribute("a", "href", "data:text/html,<script>alert(1)</script>")).toBe(true);
    expect(isUnsafeUrlAttribute("a", "href", "data:text/html;base64,PHNjcmlwdD4=")).toBe(true);
    expect(isUnsafeUrlAttribute("a", "href", "DATA:text/html,x")).toBe(true);
  });

  it("drops a non-media data: payload even on a media element", () => {
    expect(isUnsafeUrlAttribute("img", "src", "data:text/html,<script>alert(1)</script>")).toBe(true);
    expect(isUnsafeUrlAttribute("img", "src", "data:application/xml,<x/>")).toBe(true);
  });

  /**
   * The one case that has to survive: inline images are ordinary markdown
   * (`![alt](data:image/png;base64,...)`), and DOMPurify's stock config
   * allows data: on exactly these elements.
   */
  it("keeps inline media payloads on the elements DOMPurify allows them on", () => {
    expect(isUnsafeUrlAttribute("img", "src", "data:image/png;base64,iVBORw0KGgo=")).toBe(false);
    expect(isUnsafeUrlAttribute("img", "src", "data:image/svg+xml;base64,PHN2Zy8+")).toBe(false);
    expect(isUnsafeUrlAttribute("audio", "src", "data:audio/mpeg;base64,SUQz")).toBe(false);
    expect(isUnsafeUrlAttribute("video", "src", "data:video/mp4;base64,AAAA")).toBe(false);
    expect(isUnsafeUrlAttribute("source", "src", "data:image/gif;base64,R0lGOD")).toBe(false);
    expect(isUnsafeUrlAttribute("image", "xlink:href", "data:image/png;base64,iVBOR")).toBe(false);
  });

  it("does not extend that allowance to non-media elements", () => {
    expect(isUnsafeUrlAttribute("a", "href", "data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isUnsafeUrlAttribute("form", "action", "data:image/png;base64,iVBOR")).toBe(true);
  });
});

describe("isUnsafeUrlAttribute — values that must survive", () => {
  it("leaves benign and app-internal URLs intact", () => {
    const safe = [
      "https://example.com/page?a=b",
      "http://example.com",
      "mailto:someone@example.com",
      "/absolute/path.md",
      "relative/Note.md#Heading",
      "#Heading",
      "app://local/vault/image.png",
      "geode://pair?roomId=r1",
      "obsidian://pair?roomId=r1",
    ];
    for (const value of safe) {
      expect(isUnsafeUrlAttribute("a", "href", value)).toBe(false);
    }
  });

  it("ignores attributes that are not URLs, whatever they contain", () => {
    expect(isUnsafeUrlAttribute("div", "title", "javascript:alert(1)")).toBe(false);
    expect(isUnsafeUrlAttribute("div", "data-note", "data:text/html,x")).toBe(false);
  });
});

describe("SANITIZE_FORBIDDEN_TAGS", () => {
  it("removes the script-bearing and document-scope elements", () => {
    for (const tag of ["script", "iframe", "object", "embed", "link", "meta", "base"]) {
      expect(SANITIZE_FORBIDDEN_TAGS.has(tag)).toBe(true);
    }
  });

  /**
   * Deliberately allowed, to match real Obsidian (DOMPurify stock config)
   * rather than be stricter than the API being cloned. `form` keeps its
   * `action` only after the scheme check above.
   */
  it("keeps the tags DOMPurify's default config keeps", () => {
    for (const tag of ["style", "form", "input", "button", "a", "img", "svg", "table"]) {
      expect(SANITIZE_FORBIDDEN_TAGS.has(tag)).toBe(false);
    }
  });
});
