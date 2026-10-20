import { describe, expect, it } from "vitest";
import * as ObsidianAPI from "../../src/renderer/api/obsidian";

/**
 * Compat audit (TaskNotes 4.13.10, tests/fixtures/plugins/tasknotes): value
 * exports the shipped bundle reads off `require("obsidian")`. Several are
 * dereferenced at load time (`class X extends AbstractInputSuggest`), so a
 * missing one aborts the whole plugin with "Class extends value undefined".
 * `it.fails` documents the gap; remove it when the export lands.
 */
const MISSING_TODAY = [
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
  for (const name of MISSING_TODAY) {
    it.fails(`exports ${name} (GAP)`, () => expect(name in ObsidianAPI).toBe(true));
  }
  it.fails("MarkdownView.prototype.getMode exists (GAP)", () => {
    expect(typeof (ObsidianAPI.MarkdownView.prototype as any).getMode).toBe("function");
  });
});
