import { describe, expect, it } from "vitest";
import {
  planObsidianImport,
  type ImportPlanInput,
} from "../../src/main/obsidian-import";

function input(overrides: Partial<ImportPlanInput> = {}): ImportPlanInput {
  return {
    obsidianPlugins: [],
    obsidianThemes: [],
    enabledInObsidian: [],
    activeThemeInObsidian: "",
    existingGeodePlugins: [],
    existingGeodeThemes: [],
    enabledInGeode: [],
    ...overrides,
  };
}

describe("planObsidianImport — plugins", () => {
  it("copies a valid plugin (has manifest + main) and skips one missing main.js", () => {
    const plan = planObsidianImport(
      input({
        obsidianPlugins: [
          { id: "dataview", hasManifest: true, hasMain: true },
          { id: "broken", hasManifest: true, hasMain: false },
        ],
      })
    );
    expect(plan.pluginsToCopy.map((p) => p.name)).toEqual(["dataview"]);
    expect(plan.skipped).toContainEqual({
      kind: "plugin",
      name: "broken",
      reason: expect.stringContaining("main.js"),
    });
  });

  it("does not overwrite a plugin already present in .geode, but still enables it", () => {
    const plan = planObsidianImport(
      input({
        obsidianPlugins: [{ id: "dataview", hasManifest: true, hasMain: true }],
        existingGeodePlugins: ["dataview"],
        enabledInObsidian: ["dataview"],
      })
    );
    expect(plan.pluginsToCopy).toEqual([]);
    expect(plan.skipped).toContainEqual({
      kind: "plugin",
      name: "dataview",
      reason: expect.stringContaining("already"),
    });
    expect(plan.enabledPluginIds).toEqual(["dataview"]);
  });
});

describe("planObsidianImport — enabled-list merge", () => {
  it("preserves existing Geode enabled order, then appends newly enabled Obsidian ids, deduped", () => {
    const plan = planObsidianImport(
      input({
        obsidianPlugins: [
          { id: "dataview", hasManifest: true, hasMain: true },
          { id: "templater", hasManifest: true, hasMain: true },
          { id: "calendar", hasManifest: true, hasMain: true },
        ],
        enabledInGeode: ["existing-a", "dataview"],
        existingGeodePlugins: ["existing-a", "dataview"],
        enabledInObsidian: ["templater", "dataview", "calendar"],
      })
    );
    // existing order kept (existing-a, dataview), then new ones in obsidian order
    expect(plan.enabledPluginIds).toEqual([
      "existing-a",
      "dataview",
      "templater",
      "calendar",
    ]);
  });

  it("filters the enabled list to plugins that will exist after import", () => {
    const plan = planObsidianImport(
      input({
        obsidianPlugins: [{ id: "dataview", hasManifest: true, hasMain: true }],
        // "ghost" is enabled in Obsidian but has no importable folder → excluded
        enabledInObsidian: ["dataview", "ghost"],
      })
    );
    expect(plan.enabledPluginIds).toEqual(["dataview"]);
  });
});

describe("planObsidianImport — themes", () => {
  it("copies a theme with theme.css and skips one without", () => {
    const plan = planObsidianImport(
      input({
        obsidianThemes: [
          { name: "Minimal", hasThemeCss: true },
          { name: "Empty", hasThemeCss: false },
        ],
      })
    );
    expect(plan.themesToCopy.map((t) => t.name)).toEqual(["Minimal"]);
    expect(plan.skipped).toContainEqual({
      kind: "theme",
      name: "Empty",
      reason: expect.stringContaining("theme.css"),
    });
  });

  it("sets the active theme when Obsidian's active theme will exist", () => {
    const plan = planObsidianImport(
      input({
        obsidianThemes: [{ name: "Minimal", hasThemeCss: true }],
        activeThemeInObsidian: "Minimal",
      })
    );
    expect(plan.activeTheme).toBe("Minimal");
  });

  it("honors an already-present active theme even though it is not re-copied", () => {
    const plan = planObsidianImport(
      input({
        existingGeodeThemes: ["Minimal"],
        obsidianThemes: [{ name: "Minimal", hasThemeCss: true }],
        activeThemeInObsidian: "Minimal",
      })
    );
    expect(plan.themesToCopy).toEqual([]);
    expect(plan.activeTheme).toBe("Minimal");
  });

  it("leaves the active theme unchanged (null) when Obsidian had none", () => {
    const plan = planObsidianImport(
      input({
        obsidianThemes: [{ name: "Minimal", hasThemeCss: true }],
        activeThemeInObsidian: "",
      })
    );
    expect(plan.activeTheme).toBeNull();
  });

  it("does not set an active theme that will not exist after import", () => {
    const plan = planObsidianImport(
      input({
        obsidianThemes: [{ name: "Minimal", hasThemeCss: false }],
        activeThemeInObsidian: "Minimal",
      })
    );
    expect(plan.activeTheme).toBeNull();
  });
});

describe("planObsidianImport — empty vault", () => {
  it("returns an empty plan when there is nothing to import", () => {
    const plan = planObsidianImport(input());
    expect(plan.pluginsToCopy).toEqual([]);
    expect(plan.themesToCopy).toEqual([]);
    expect(plan.enabledPluginIds).toEqual([]);
    expect(plan.activeTheme).toBeNull();
    expect(plan.skipped).toEqual([]);
  });
});
