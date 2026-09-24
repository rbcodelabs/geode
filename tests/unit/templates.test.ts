import { describe, expect, it } from "vitest";
import moment from "moment";
import { TemplatesService, resolveTemplatesConfig, renderTemplate, templateFiles, templatePath, templateNoteName } from "../../src/renderer/templates";
import type { TFile } from "../../src/renderer/types";

describe("templates", () => {
  const now = moment("2026-09-24T14:05:00");
  it("renders title and configured date/time in one pass, preserving unknown variables", () => {
    expect(renderTemplate("{{title}} {{date}} {{time}} {{unknown}}", "{{date}}", now,
      { dateFormat: "DD/MM/YYYY", timeFormat: "h:mm A" })).toBe("{{date}} 24/09/2026 2:05 PM {{unknown}}");
  });
  it("supports explicit Moment formats with punctuation and literal braces", () => {
    expect(renderTemplate("{{date:YYYY/MM/DD}} {{time:HH:mm:ss}} {{date:[{day}] D}}", "Note", now))
      .toBe("2026/09/24 14:05:00 {day} 24");
  });
  it("preserves empty templates", () => expect(renderTemplate("", "Note", now)).toBe(""));
  it("accepts plain titles and strips an optional markdown extension", () => {
    expect(templateNoteName(" Planning.md ")).toBe("Planning");
    expect(templateNoteName("Team sync")).toBe("Team sync");
  });
  it.each([".md", " ", "../outside", "folder/note", "folder\\note", "Title#heading", ".", "..", "Hidden\u0000note"])("rejects invalid note name %j", name => {
    expect(() => templateNoteName(name)).toThrow("Invalid file name");
  });
  it("validates config per field and normalizes folder separators", () => {
    expect(resolveTemplatesConfig(null)).toEqual({ enabled: true, folder: "Templates", dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" });
    expect(resolveTemplatesConfig({ enabled: false, folder: " /Snippets/ ", dateFormat: 2, timeFormat: " h:mm A " }))
      .toEqual({ enabled: false, folder: "Snippets", dateFormat: "YYYY-MM-DD", timeFormat: "h:mm A" });
    expect(resolveTemplatesConfig({ folder: "" }).folder).toBe("");
  });
  it("lists markdown templates recursively without matching similarly prefixed folders", () => {
    const files = ["Templates/B.md", "Templates/Nested/A.md", "Templates-old/C.md", "Templates/image.png"]
      .map(path => ({ path, extension: path.split(".").pop() }) as TFile);
    expect(templateFiles(files, "Templates").map(f => f.path)).toEqual(["Templates/B.md", "Templates/Nested/A.md"]);
  });
  it("resolves paths with or without markdown extensions", () => {
    expect(templatePath(" Templates/Daily ")).toBe("Templates/Daily.md");
    expect(templatePath("Templates/Daily.md")).toBe("Templates/Daily.md");
  });
  it("serializes updates and retains last persisted values on failure", async () => {
    const writes: unknown[] = [];
    const service = new TemplatesService({ read: async () => ({ folder: "Snippets" }), write: async (_name, value) => { writes.push(value); } });
    await service.load();
    await Promise.all([service.update({ dateFormat: "DD/MM" }), service.update({ enabled: false })]);
    expect(service.options.folder).toBe("Snippets");
    expect(writes.at(-1)).toEqual({ enabled: false, folder: "Snippets", dateFormat: "DD/MM", timeFormat: "HH:mm" });
    const failing = new TemplatesService({ read: async () => null, write: async () => { throw new Error("disk full"); } });
    await expect(failing.update({ folder: "Other" })).rejects.toThrow("disk full");
    expect(failing.options.folder).toBe("Templates");
  });
});
