import { describe, expect, it } from "vitest";
import {
  normalizeItemKey,
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

describe("normalizeItemKey", () => {
  it("folds case and unicode normalization the way the filesystem does", () => {
    expect(normalizeItemKey("MyPlugin")).toBe(normalizeItemKey("myplugin"));
    expect(normalizeItemKey("Café")).toBe(normalizeItemKey("café"));
    expect(normalizeItemKey("A")).not.toBe(normalizeItemKey("B"));
  });
});

describe("planObsidianImport — name collisions (B1)", () => {
  it("skips a plugin whose name differs from an installed one only by case", () => {
    const plan = planObsidianImport(
      input({
        obsidianPlugins: [{ id: "dataview", hasManifest: true, hasMain: true }],
        existingGeodePlugins: ["Dataview"],
      })
    );
    expect(plan.pluginsToCopy).toEqual([]);
    const skip = plan.skipped.find((s) => s.name === "dataview");
    // The reason names the on-disk item AND preserves the incoming spelling.
    expect(skip?.reason).toContain('"Dataview"');
    expect(skip?.reason).toContain('"dataview"');
    expect(skip?.reason).toContain("case/unicode variant");
  });

  it("skips a plugin whose name differs only by unicode normalization", () => {
    const plan = planObsidianImport(
      input({
        obsidianPlugins: [{ id: "Café", hasManifest: true, hasMain: true }],
        existingGeodePlugins: ["Café"],
      })
    );
    expect(plan.pluginsToCopy).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });

  it("skips a theme whose name differs from an installed one only by case", () => {
    const plan = planObsidianImport(
      input({
        obsidianThemes: [{ name: "minimal", hasThemeCss: true }],
        existingGeodeThemes: ["Minimal"],
      })
    );
    expect(plan.themesToCopy).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('"Minimal"');
  });

  it("copies only one of two Obsidian folders that collide with each other", () => {
    const plan = planObsidianImport(
      input({
        obsidianPlugins: [
          { id: "Widget", hasManifest: true, hasMain: true },
          { id: "widget", hasManifest: true, hasMain: true },
        ],
      })
    );
    expect(plan.pluginsToCopy.map((p) => p.name)).toEqual(["Widget"]);
    expect(plan.skipped.map((s) => s.name)).toEqual(["widget"]);
  });

  it("keeps the plain 'already present' wording for an exact-name match", () => {
    const plan = planObsidianImport(
      input({
        obsidianPlugins: [{ id: "dataview", hasManifest: true, hasMain: true }],
        existingGeodePlugins: ["dataview"],
      })
    );
    expect(plan.skipped[0]?.reason).not.toContain("variant");
    expect(plan.skipped[0]?.reason).toContain("already present");
  });
});

describe("planObsidianImport — theme overwrite guard covers every directory (B2)", () => {
  it("protects an existing theme name that is not renderable", () => {
    const plan = planObsidianImport(
      input({
        obsidianThemes: [{ name: "Minimal", hasThemeCss: true }],
        // Directory exists (guard) but has no theme.css (not renderable).
        existingGeodeThemes: ["Minimal"],
        renderableGeodeThemes: [],
        activeThemeInObsidian: "Minimal",
      })
    );
    expect(plan.themesToCopy).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    // Nothing renderable by that name ⇒ don't switch the user's theme to it.
    expect(plan.activeTheme).toBeNull();
  });

  it("resolves the active theme to the on-disk spelling", () => {
    const plan = planObsidianImport(
      input({
        obsidianThemes: [{ name: "minimal", hasThemeCss: true }],
        existingGeodeThemes: ["Minimal"],
        renderableGeodeThemes: ["Minimal"],
        activeThemeInObsidian: "minimal",
      })
    );
    expect(plan.activeTheme).toBe("Minimal");
  });
});

describe("planObsidianImport — enable only what is copied (B3a)", () => {
  it("never enables a plugin that was already installed in Geode", () => {
    const plan = planObsidianImport(
      input({
        obsidianPlugins: [{ id: "buggy", hasManifest: true, hasMain: true }],
        existingGeodePlugins: ["buggy"],
        enabledInGeode: [], // user deliberately switched it off
        enabledInObsidian: ["buggy"], // stale .obsidian config still lists it
      })
    );
    expect(plan.pluginsToCopy).toEqual([]);
    expect(plan.pluginsToEnable).toEqual([]);
    // The merged view still reports it as installed — it is just not actionable.
    expect(plan.enabledPluginIds).toEqual(["buggy"]);
  });

  it("enables a newly copied plugin that Obsidian had enabled, and only that one", () => {
    const plan = planObsidianImport(
      input({
        obsidianPlugins: [
          { id: "wanted", hasManifest: true, hasMain: true },
          { id: "alsonew", hasManifest: true, hasMain: true },
        ],
        enabledInObsidian: ["wanted"],
      })
    );
    expect(plan.pluginsToCopy.map((p) => p.name)).toEqual(["wanted", "alsonew"]);
    expect(plan.pluginsToEnable).toEqual(["wanted"]);
  });

  it("does not enable a case-variant of an already-installed plugin", () => {
    const plan = planObsidianImport(
      input({
        obsidianPlugins: [{ id: "buggy", hasManifest: true, hasMain: true }],
        existingGeodePlugins: ["Buggy"],
        enabledInGeode: [],
        enabledInObsidian: ["buggy"],
      })
    );
    expect(plan.pluginsToEnable).toEqual([]);
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
