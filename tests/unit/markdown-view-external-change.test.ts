import { describe, expect, it } from "vitest";
import { hasExternalChange } from "../../src/renderer/views/markdown-view";

// Regression coverage for the markdown editor flicker bug: MarkdownView's own
// autosave write echoes back as a vault "modify" event, and that echo must
// NOT be misread as an external change. See markdown-view.ts's
// `hasExternalChange` doc comment and app.ts's vault "modify" handler.
describe("hasExternalChange", () => {
  it("returns false when disk text matches the last-known-saved text (own-write echo)", () => {
    expect(hasExternalChange("hello world", "hello world")).toBe(false);
  });

  it("returns true when disk text differs from the last-known-saved text (genuine external edit)", () => {
    expect(hasExternalChange("hello world\nexternal edit", "hello world")).toBe(true);
  });

  it("returns false for two independent empty strings (no-op comparison)", () => {
    expect(hasExternalChange("", "")).toBe(false);
  });
});
