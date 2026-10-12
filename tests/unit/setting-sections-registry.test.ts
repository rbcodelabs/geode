import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// App is DOM-bound, so assert the contract at source level: sections are keyed
// `<pluginId>:<sectionId>`, tracked in settingTabMeta, and cleaned up on unload.
describe("plugin setting sections", () => {
  const app = readFileSync("src/renderer/app.ts", "utf8");
  const api = readFileSync("src/renderer/api/obsidian.ts", "utf8");
  it("registers sections under a composite id with nav metadata", () => {
    expect(app).toContain("registerSettingSection(pluginId: string, sectionId: string");
    expect(app).toContain("`${pluginId}:${sectionId}`");
    expect(app).toContain("settingTabMeta.delete(id)");
  });
  it("exposes Plugin.addSettingSection with unload cleanup", () => {
    expect(api).toContain("addSettingSection(section:");
    expect(api).toContain("unregisterSettingSection?.(this.manifest.id, section.id)");
  });
});
