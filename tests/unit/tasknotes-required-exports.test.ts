import { describe, expect, it } from "vitest";
import * as ObsidianAPI from "../../src/renderer/api/obsidian";

/**
 * Compat audit (TaskNotes 4.13.10, tests/fixtures/plugins/tasknotes): value
 * exports the shipped bundle reads off `require("obsidian")`. Several are
 * dereferenced at load time (`class X extends AbstractInputSuggest`), so a
 * missing one aborts the whole plugin with "Class extends value undefined".
 * Previously these were `it.fails` gaps; they are now real assertions.
 */
const FORMERLY_MISSING = [
  "AbstractInputSuggest",
  "SettingGroup",
  "TAbstractFile",
  "editorInfoField",
  "editorLivePreviewField",
  "getIconIds",
  "getLanguage",
  "parseFrontMatterAliases",
  "requireApiVersion",
];

const PRESENT = [
  "Component", "Events", "FuzzySuggestModal", "ItemView", "MarkdownRenderer", "MarkdownView", "Menu", "Modal", "Notice",
  "Platform", "Plugin", "PluginSettingTab", "Scope", "Setting", "SuggestModal", "TFile", "Vault", "addIcon",
  "getFrontMatterInfo", "moment", "normalizePath", "parseFrontMatterTags", "parseLinktext", "parseYaml",
  "requestUrl", "sanitizeHTMLToDom", "setIcon", "setTooltip", "stringifyYaml",
];

describe("TaskNotes required obsidian exports", () => {
  for (const name of PRESENT) {
    it(`exports ${name}`, () => expect(name in ObsidianAPI).toBe(true));
  }
  for (const name of FORMERLY_MISSING) {
    it(`exports ${name}`, () => expect((ObsidianAPI as Record<string, unknown>)[name]).toBeDefined());
  }
  it("MarkdownView.prototype.getMode exists", () => {
    expect(typeof ObsidianAPI.MarkdownView.prototype.getMode).toBe("function");
  });
});
