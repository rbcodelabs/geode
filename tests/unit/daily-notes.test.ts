import { describe, expect, it } from "vitest";
import moment from "moment";
import {
  DailyNotesService,
  resolveDailyNoteSettings,
  resolveDailyNotesConfig,
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

describe("resolveDailyNotesConfig", () => {
  it("enables Daily Notes by default for new and existing vaults", () => {
    expect(resolveDailyNotesConfig(null)).toEqual({
      enabled: true,
      folder: "",
      format: "YYYY-MM-DD",
      template: "",
    });
    expect(resolveDailyNotesConfig({ folder: "Journal" })).toEqual({
      enabled: true,
      folder: "Journal",
      format: "YYYY-MM-DD",
      template: "",
    });
  });

  it.each([
    [{ enabled: "false", folder: 42, format: [], template: {} }, { enabled: true, folder: "", format: "YYYY-MM-DD", template: "" }],
    [{ enabled: false, folder: "/Journal/", format: " YYYY.MM.DD ", template: " Templates/Daily.md " }, { enabled: false, folder: "Journal", format: "YYYY.MM.DD", template: "Templates/Daily.md" }],
  ])("validates malformed legacy config per field", (raw, expected) => {
    expect(resolveDailyNotesConfig(raw)).toEqual(expected);
  });
});

describe("DailyNotesService", () => {
  it("loads validated state and keeps the plugin-facing options reference live", async () => {
    const writes: unknown[] = [];
    const store = {
      read: async () => ({ enabled: false, folder: "Journal", format: "YYYY.MM.DD", template: "" }),
      write: async (_name: string, value: unknown) => { writes.push(value); },
    };
    const service = new DailyNotesService(store);
    const retainedOptions = service.options;

    await service.load();
    expect(service.enabled).toBe(false);
    expect(service.options).toBe(retainedOptions);
    expect(retainedOptions).toEqual({ folder: "Journal", format: "YYYY.MM.DD", template: "" });

    await service.update({ enabled: true, folder: "Notes/Daily" });
    expect(service.enabled).toBe(true);
    expect(service.options).toBe(retainedOptions);
    expect(retainedOptions).toEqual({ folder: "Notes/Daily", format: "YYYY.MM.DD", template: "" });
    expect(writes).toEqual([{ enabled: true, folder: "Notes/Daily", format: "YYYY.MM.DD", template: "" }]);
  });

  it("serializes concurrent updates without losing fields", async () => {
    let persisted: unknown = null;
    const store = {
      read: async () => null,
      write: async (_name: string, value: unknown) => {
        await Promise.resolve();
        persisted = value;
      },
    };
    const service = new DailyNotesService(store);
    await service.load();

    await Promise.all([
      service.update({ folder: "Journal" }),
      service.update({ template: "Templates/Daily" }),
    ]);

    expect(persisted).toEqual({
      enabled: true,
      folder: "Journal",
      format: "YYYY-MM-DD",
      template: "Templates/Daily",
    });
  });

  it("does not publish settings that fail to persist", async () => {
    const service = new DailyNotesService({
      read: async () => null,
      write: async () => { throw new Error("disk full"); },
    });
    await service.load();
    const retainedOptions = service.options;

    await expect(service.update({ enabled: false, folder: "Journal" })).rejects.toThrow("disk full");

    expect(service.enabled).toBe(true);
    expect(service.options).toBe(retainedOptions);
    expect(service.options).toEqual({ folder: "", format: "YYYY-MM-DD", template: "" });
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
