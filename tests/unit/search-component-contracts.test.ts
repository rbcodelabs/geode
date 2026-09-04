import { describe, expect, it } from "vitest";
import * as ObsidianApi from "../../src/renderer/api/obsidian";
import { instantiatePluginClass } from "../../src/renderer/plugin-manager";

describe("Obsidian text component exports", () => {
  it("exports the public text hierarchy", () => {
    expect(ObsidianApi.BaseComponent).toBeTypeOf("function");
    expect(ObsidianApi.ValueComponent).toBeTypeOf("function");
    expect(ObsidianApi.AbstractTextComponent).toBeTypeOf("function");
    expect(ObsidianApi.SearchComponent).toBeTypeOf("function");
  });

  it("makes SearchComponent available through plugin require('obsidian')", () => {
    const PluginClass = instantiatePluginClass(
      `
        const obsidian = require("obsidian");
        module.exports = class SearchComponentProbe extends obsidian.Plugin {
          static results = {
            hasSearch: typeof obsidian.SearchComponent === "function",
            hierarchy:
              obsidian.SearchComponent.prototype instanceof obsidian.AbstractTextComponent &&
              obsidian.AbstractTextComponent.prototype instanceof obsidian.ValueComponent &&
              obsidian.ValueComponent.prototype instanceof obsidian.BaseComponent,
          };
        };
      `,
      "search-component-probe",
    ) as unknown as { results: unknown };

    expect(PluginClass.results).toEqual({ hasSearch: true, hierarchy: true });
  });
});
