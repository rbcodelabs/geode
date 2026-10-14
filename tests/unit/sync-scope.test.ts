import { describe, expect, it } from "vitest";
import { DEFAULT_SYNC_SCOPE, isPathInSyncScope, portableConfigCategory, validateSyncPath } from "../../src/renderer/sync/scope";

describe("sync scope", () => {
  it("includes authored content and excludes operational, secret, trash, and hidden state", () => {
    expect(isPathInSyncScope("Notes/A.md", DEFAULT_SYNC_SCOPE)).toBe(true);
    expect(isPathInSyncScope("image.png", DEFAULT_SYNC_SCOPE)).toBe(true);
    expect(isPathInSyncScope(".geode/app.json", DEFAULT_SYNC_SCOPE)).toBe(true);
    expect(isPathInSyncScope(".geode/sync/journal.json", DEFAULT_SYNC_SCOPE)).toBe(false);
    expect(isPathInSyncScope(".geode-trash/A.md", DEFAULT_SYNC_SCOPE)).toBe(false);
    expect(isPathInSyncScope(".private/token", DEFAULT_SYNC_SCOPE)).toBe(false);
    expect(isPathInSyncScope("Notes/.private/token", DEFAULT_SYNC_SCOPE)).toBe(false);
  });

  it("honors type and folder exclusions", () => {
    const scope = { ...DEFAULT_SYNC_SCOPE, images: false, excludedFolders: ["Archive"] };
    expect(isPathInSyncScope("photo.JPG", scope)).toBe(false);
    expect(isPathInSyncScope("Archive/old.md", scope)).toBe(false);
  });

  it("rejects traversal, reserved paths, and non-normalized paths", () => {
    expect(() => validateSyncPath("../escape.md")).toThrow();
    expect(() => validateSyncPath(".geode/sync/state.json")).toThrow();
    expect(() => validateSyncPath("A\\B.md")).toThrow();
    expect(() => validateSyncPath("/absolute.md")).toThrow();
    expect(() => validateSyncPath("C:/drive.md")).toThrow();
  });

  it("classifies portable configuration for .geode/ and .obsidian/ with the same allowlist", () => {
    for (const base of [".geode", ".obsidian"]) {
      expect(portableConfigCategory(`${base}/app.json`)).toBe("mainSettings");
      expect(portableConfigCategory(`${base}/appearance.json`)).toBe("appearance");
      expect(portableConfigCategory(`${base}/hotkeys.json`)).toBe("hotkeys");
      expect(portableConfigCategory(`${base}/core-plugins.json`)).toBe("corePlugins");
      expect(portableConfigCategory(`${base}/daily-notes.json`)).toBe("corePlugins");
      expect(portableConfigCategory(`${base}/community-plugins.json`)).toBe("communityPlugins");
      expect(portableConfigCategory(`${base}/themes/Dark/theme.css`)).toBe("themesAndSnippets");
      expect(portableConfigCategory(`${base}/snippets/a.css`)).toBe("themesAndSnippets");
      expect(portableConfigCategory(`${base}/plugins/x/data.json`)).toBe("communityPluginData");
      for (const never of ["workspace.json", "workspace-mobile.json", "graph.json", "cache/a", "sync/state.json", "plugins/x/node_modules/y.js", "plugins/x/cache/z", "plugins/x/.hidden", "themes/.DS_Store", ".DS_Store", "other.json"]) expect(portableConfigCategory(`${base}/${never}`), never).toBeNull();
    }
    for (const never of [".git/config", ".trash/a.md", ".geode-trash/a.md", ".geode-sync-tmp/x", ".worktrees/a/app.json", ".claude/app.json", ".gitignore", ".gitkeep", ".linear.json", "Notes/app.json", ".obsidian/../x", "app.json"]) expect(portableConfigCategory(never), never).toBeNull();
  });

  it("keeps the app's own scope decisions unchanged for .obsidian/ (only a raw-file host looks there)", () => {
    expect(isPathInSyncScope(".obsidian/app.json", DEFAULT_SYNC_SCOPE)).toBe(false);
    expect(JSON.stringify(DEFAULT_SYNC_SCOPE)).not.toContain("rawConfig");
  });
});
