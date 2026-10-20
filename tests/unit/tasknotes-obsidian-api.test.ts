import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import * as ObsidianAPI from "../../src/renderer/api/obsidian";
import { moveSuggestionIndex, initialSuggestionIndex } from "../../src/renderer/api/input-suggest";
import { resolveLanguageCode } from "../../src/renderer/api/language";
import { parseFrontMatterAliases } from "../../src/renderer/api/frontmatter";
import { addIcon, getIconIds, getIconSvg } from "../../src/renderer/api/icons";
import {
  editorInfoExtension,
  editorInfoField,
  editorLivePreviewField,
  livePreviewFlagExtension,
} from "../../src/renderer/editor-info-fields";
import { GEODE_API_VERSION } from "../../src/renderer/plugin-manifest";
import { MarkdownView } from "../../src/renderer/views/markdown-view";

describe("moveSuggestionIndex", () => {
  it("wraps in both directions", () => {
    expect(moveSuggestionIndex(0, 1, 3)).toBe(1);
    expect(moveSuggestionIndex(2, 1, 3)).toBe(0);
    expect(moveSuggestionIndex(0, -1, 3)).toBe(2);
  });
  it("handles an empty list and a no-selection start", () => {
    expect(moveSuggestionIndex(-1, 1, 0)).toBe(-1);
    expect(moveSuggestionIndex(-1, 1, 3)).toBe(0);
    expect(moveSuggestionIndex(-1, -1, 3)).toBe(2);
    expect(initialSuggestionIndex(0)).toBe(-1);
    expect(initialSuggestionIndex(4)).toBe(0);
  });
});

describe("resolveLanguageCode", () => {
  it("reduces regional locales to the bare language", () => {
    expect(resolveLanguageCode("en-US")).toBe("en");
    expect(resolveLanguageCode("de_DE")).toBe("de");
  });
  it("keeps the zh-TW and pt-BR variants Obsidian ships", () => {
    expect(resolveLanguageCode("zh-TW")).toBe("zh-TW");
    expect(resolveLanguageCode("zh-Hant-HK")).toBe("zh-TW");
    expect(resolveLanguageCode("zh-CN")).toBe("zh");
    expect(resolveLanguageCode("pt-BR")).toBe("pt-BR");
    expect(resolveLanguageCode("pt-PT")).toBe("pt");
  });
  it("falls back to en for missing or garbage input", () => {
    expect(resolveLanguageCode(undefined)).toBe("en");
    expect(resolveLanguageCode("")).toBe("en");
    expect(resolveLanguageCode("!!")).toBe("en");
  });
});

describe("parseFrontMatterAliases", () => {
  it("reads arrays, trimming and dropping empties", () => {
    expect(parseFrontMatterAliases({ aliases: [" A ", "", "B"] })).toEqual(["A", "B"]);
  });
  it("splits a comma string and falls back to the singular key", () => {
    expect(parseFrontMatterAliases({ alias: "x, y" })).toEqual(["x", "y"]);
    expect(parseFrontMatterAliases({ aliases: ["p"], alias: "q" })).toEqual(["p"]);
  });
  it("stringifies numbers and ignores objects", () => {
    expect(parseFrontMatterAliases({ aliases: [2024, { a: 1 }, null] })).toEqual(["2024"]);
  });
  it("returns null for no frontmatter, no key, or nothing usable", () => {
    expect(parseFrontMatterAliases(null)).toBeNull();
    expect(parseFrontMatterAliases({ title: "t" })).toBeNull();
    expect(parseFrontMatterAliases({ aliases: [] })).toBeNull();
  });
});

describe("getIconIds", () => {
  it("lists Lucide ids with the lucide- prefix, all resolvable by setIcon's lookup", () => {
    const ids = getIconIds();
    expect(ids).toContain("lucide-check");
    expect(ids).toContain("lucide-a-arrow-down");
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids.filter((i) => i.startsWith("lucide-")).slice(0, 200)) expect(getIconSvg(id), id).not.toBeNull();
  });
  it("includes plugin-registered icons under their own id", () => {
    addIcon("tn-test-icon", "<svg>x</svg>");
    expect(getIconIds()).toContain("tn-test-icon");
  });
});

describe("requireApiVersion", () => {
  it("compares against GEODE_API_VERSION, not the app version", () => {
    expect(ObsidianAPI.requireApiVersion(GEODE_API_VERSION)).toBe(true);
    expect(ObsidianAPI.requireApiVersion("1.0.0")).toBe(true);
    expect(ObsidianAPI.requireApiVersion("1.10.1")).toBe(true);
    expect(ObsidianAPI.requireApiVersion("1.11.0")).toBe(false);
    expect(ObsidianAPI.requireApiVersion("1.12.2")).toBe(false);
  });
});

describe("TAbstractFile", () => {
  it("matches both files and folders, and nothing else", () => {
    const { TAbstractFile, TFile, TFolder } = ObsidianAPI;
    const file = { kind: "file", path: "a.md", name: "a.md" };
    const folder = { kind: "folder", path: "d", name: "d" };
    expect(file instanceof TAbstractFile).toBe(true);
    expect(folder instanceof TAbstractFile).toBe(true);
    expect(file instanceof TFolder).toBe(false);
    expect(folder instanceof TFile).toBe(false);
    expect(null instanceof TAbstractFile).toBe(false);
    expect({ path: "x" } instanceof TAbstractFile).toBe(false);
  });
});

describe("editorInfoField / editorLivePreviewField", () => {
  it("expose the host view and Live Preview flag when the host extensions are installed", () => {
    const host = { file: { path: "n.md" } };
    const live = EditorState.create({ doc: "", extensions: [editorInfoExtension(host), livePreviewFlagExtension()] });
    expect(live.field(editorInfoField)).toBe(host);
    expect(live.field(editorLivePreviewField)).toBe(true);
    const source = EditorState.create({ doc: "", extensions: [editorInfoExtension(host)] });
    expect(source.field(editorLivePreviewField)).toBe(false);
  });
  it("are absent from an editor state that does not install them", () => {
    const state = EditorState.create({ doc: "" });
    expect(state.field(editorInfoField, false)).toBeUndefined();
    expect(state.field(editorLivePreviewField, false)).toBeUndefined();
  });
});

describe("MarkdownView.getMode", () => {
  const modeOf = (mode: string) => MarkdownView.prototype.getMode.call({ mode });
  it("reports preview only for Reading view", () => {
    expect(modeOf("reading")).toBe("preview");
    expect(modeOf("live")).toBe("source");
    expect(modeOf("source")).toBe("source");
  });
});
