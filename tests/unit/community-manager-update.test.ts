import { afterEach, describe, expect, it, vi } from "vitest";
import { CommunityManager } from "../../src/renderer/community/community-manager";

afterEach(() => { delete (globalThis as any).window; });

describe("CommunityManager update admission", () => {
  it("installs the admitted resolved release ref and rejects changed returned identity before reload", async () => {
    const reload = vi.fn();
    const installCommunity = vi.fn(async () => ({
      repo: "kepano/obsidian-minimal-settings",
      type: "plugin",
      id: "obsidian-minimal-settings",
      name: "Minimal Theme Settings",
      version: "9.0.1",
      minAppVersion: "1.13.0",
      source: "release",
      ref: "9.0.1",
    }));
    (globalThis as any).window = { geode: {
      readConfig: vi.fn(async () => ({ version: 1, items: [{
        repo: "kepano/obsidian-minimal-settings", type: "plugin", id: "obsidian-minimal-settings",
        installedVersion: "8.0.0", source: "release", ref: "8.0.0", autoUpdate: true,
      }] })),
      writeConfig: vi.fn(async () => {}),
      resolveCommunity: vi.fn(async () => ({
        repo: "kepano/obsidian-minimal-settings", type: "plugin", id: "obsidian-minimal-settings",
        name: "Minimal Theme Settings", version: "9.0.0", minAppVersion: "1.13.0",
        source: "release", ref: "9.0.0",
      })),
      installCommunity,
    } };
    const manager = new CommunityManager({
      pluginManager: { reload, isMobileRuntime: () => false },
      settings: { cssTheme: "" },
      host: { runtime: { runtime: "electron" } },
    } as any);

    const result = await manager.checkForUpdates({ force: true });

    expect(installCommunity).toHaveBeenCalledWith("kepano/obsidian-minimal-settings", {
      type: "plugin",
      tag: "9.0.0",
      expected: expect.objectContaining({ id: "obsidian-minimal-settings", version: "9.0.0" }),
    });
    expect(reload).not.toHaveBeenCalled();
    expect(result.failed[0].error).toMatch(/changed after admission/);
  });

  it.each([
    [{ id: "different-plugin" }, /resolved as plugin "different-plugin"/],
    [{ minAppVersion: undefined }, /missing minAppVersion/],
  ])("rejects an invalid plugin preview before install", async (previewOverrides, expectedError) => {
    const installCommunity = vi.fn();
    (globalThis as any).window = { geode: {
      readConfig: vi.fn(async () => ({ version: 1, items: [{
        repo: "kepano/obsidian-minimal-settings", type: "plugin", id: "obsidian-minimal-settings",
        installedVersion: "8.0.0", source: "release", ref: "8.0.0", autoUpdate: true,
      }] })),
      writeConfig: vi.fn(async () => {}),
      resolveCommunity: vi.fn(async () => ({
        repo: "kepano/obsidian-minimal-settings", type: "plugin", id: "obsidian-minimal-settings",
        name: "Minimal Theme Settings", version: "9.0.0", minAppVersion: "1.13.0",
        source: "release", ref: "9.0.0", ...previewOverrides,
      })),
      installCommunity,
    } };
    const manager = new CommunityManager({
      pluginManager: { reload: vi.fn(), isMobileRuntime: () => false },
      settings: { cssTheme: "" }, host: { runtime: { runtime: "electron" } },
    } as any);
    const result = await manager.checkForUpdates({ force: true });
    expect(result.failed[0].error).toMatch(expectedError);
    expect(installCommunity).not.toHaveBeenCalled();
  });
});
