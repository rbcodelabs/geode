import { describe, expect, it } from "vitest";
import { DEFAULT_SYNC_SCOPE, isPathInSyncScope, validateSyncPath } from "../../src/renderer/sync/scope";

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
});
