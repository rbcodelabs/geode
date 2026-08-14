import { describe, expect, it } from "vitest";
import moment from "moment";
import {
  resolveDailyNoteSettings,
  matchDailyNoteFile,
  dailyNotePath,
} from "../../src/renderer/daily-notes";
import { pathParent, pathName, splitExt, type TFile } from "../../src/renderer/types";

function file(path: string): TFile {
  const name = pathName(path);
  const { basename, extension } = splitExt(name);
  return { kind: "file", path, name, basename, extension, mtime: 0, ctime: 0, size: 0, parent: pathParent(path) };
}

describe("resolveDailyNoteSettings", () => {
  it("applies Obsidian's defaults when given null/unset config", () => {
    expect(resolveDailyNoteSettings(null)).toEqual({
      folder: "",
      format: "YYYY-MM-DD",
      template: "",
    });
    expect(resolveDailyNoteSettings(undefined)).toEqual({
      folder: "",
      format: "YYYY-MM-DD",
      template: "",
    });
    expect(resolveDailyNoteSettings({})).toEqual({
      folder: "",
      format: "YYYY-MM-DD",
      template: "",
    });
  });

  it("keeps custom folder/format/template values, trimmed", () => {
    expect(
      resolveDailyNoteSettings({
        folder: " Journal/Daily ",
        format: " YYYY-MM-DD-ddd ",
        template: " Templates/Daily.md ",
      })
    ).toEqual({
      folder: "Journal/Daily",
      format: "YYYY-MM-DD-ddd",
      template: "Templates/Daily.md",
    });
  });

  it("strips leading/trailing slashes from a custom folder", () => {
    expect(resolveDailyNoteSettings({ folder: "/Journal/" }).folder).toBe("Journal");
  });

  it("falls back to defaults for blank (whitespace-only) fields", () => {
    expect(resolveDailyNoteSettings({ folder: "   ", format: "  ", template: "  " })).toEqual({
      folder: "",
      format: "YYYY-MM-DD",
      template: "",
    });
  });
});

describe("matchDailyNoteFile", () => {
  it("matches files at vault root against the default format", () => {
    const settings = resolveDailyNoteSettings(null);
    const files = [file("2026-08-13.md"), file("2026-08-12.md"), file("Not A Date.md")];
    const index = matchDailyNoteFile(files, settings);
    expect(index.size).toBe(2);
    expect(index.get("2026-08-13")?.path).toBe("2026-08-13.md");
    expect(index.get("2026-08-12")?.path).toBe("2026-08-12.md");
  });

  it("matches only files under a custom folder, using a custom format", () => {
    const settings = resolveDailyNoteSettings({ folder: "Journal", format: "YYYY.MM.DD" });
    const files = [
      file("Journal/2026.08.13.md"),
      file("2026.08.13.md"), // same name, but not under the configured folder
      file("Journal/Sub/2026.08.13.md"), // nested past the folder, doesn't match a flat format
    ];
    const index = matchDailyNoteFile(files, settings);
    expect(index.size).toBe(1);
    expect(index.get("2026.08.13")?.path).toBe("Journal/2026.08.13.md");
  });

  it("handles a nested-folder date format (YYYY/MMMM/YYYY-MMM-DD)", () => {
    const settings = resolveDailyNoteSettings({ folder: "Journal", format: "YYYY/MMMM/YYYY-MMM-DD" });
    const files = [
      file("Journal/2026/August/2026-Aug-13.md"),
      file("Journal/2026/August/not-a-date.md"),
      file("Journal/2026-Aug-13.md"), // missing the nested month folder, shouldn't match
    ];
    const index = matchDailyNoteFile(files, settings);
    expect(index.size).toBe(1);
    const match = index.get("2026/August/2026-Aug-13");
    expect(match?.path).toBe("Journal/2026/August/2026-Aug-13.md");
  });

  it("returns an empty index when no file matches the configured format", () => {
    const settings = resolveDailyNoteSettings(null);
    const files = [file("Welcome.md"), file("Ideas/Brainstorm.md")];
    const index = matchDailyNoteFile(files, settings);
    expect(index.size).toBe(0);
  });
});

describe("dailyNotePath", () => {
  it("places the note at vault root by default", () => {
    const settings = resolveDailyNoteSettings(null);
    expect(dailyNotePath(moment("2026-08-13", "YYYY-MM-DD"), settings)).toBe("2026-08-13.md");
  });

  it("nests the note under the configured folder", () => {
    const settings = resolveDailyNoteSettings({ folder: "Journal", format: "YYYY-MM-DD" });
    expect(dailyNotePath(moment("2026-08-13", "YYYY-MM-DD"), settings)).toBe(
      "Journal/2026-08-13.md"
    );
  });
});
