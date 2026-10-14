import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CommunityManager } from "../../src/renderer/community/community-manager";

function managerWith(reload: ReturnType<typeof vi.fn>) {
  (globalThis as any).window = { geode: {
    readConfig: vi.fn(async () => ({ version: 1, items: [{
      repo: "o/p", type: "plugin", id: "p", installedVersion: "1.0.0", source: "release", ref: "1.0.0", autoUpdate: true,
    }] })),
    writeConfig: vi.fn(async () => {}),
    resolveCommunity: vi.fn(async () => ({
      repo: "o/p", type: "plugin", id: "p", name: "P", version: "1.1.0", minAppVersion: "1.0.0", source: "release", ref: "1.1.0",
    })),
    installCommunity: vi.fn(async () => ({
      repo: "o/p", type: "plugin", id: "p", name: "P", version: "1.1.0", minAppVersion: "1.0.0", source: "release", ref: "1.1.0",
    })),
  } };
  const app = { pluginManager: { reload, isMobileRuntime: () => false }, settings: { cssTheme: "" }, host: { runtime: { runtime: "electron" } } };
  return { manager: new CommunityManager(app as any), install: (globalThis as any).window.geode.installCommunity };
}

describe("launch-time community update", () => {
  it("installs on disk without pluginManager.reload when reload:false", async () => {
    const reload = vi.fn();
    const { manager, install } = managerWith(reload);
    const sum = await manager.checkForUpdates({ force: true, reload: false });
    expect(install).toHaveBeenCalledTimes(1);
    expect(sum.updated).toEqual(["P 1.1.0"]);
    expect(reload).not.toHaveBeenCalled();
    delete (globalThis as any).window;
  });

  it("still hot-reloads by default (manual Update now path)", async () => {
    const reload = vi.fn();
    const { manager } = managerWith(reload);
    await manager.checkForUpdates({ force: true });
    expect(reload).toHaveBeenCalledWith("p");
    delete (globalThis as any).window;
  });

  it("does not start another item once aborted", async () => {
    const reload = vi.fn();
    const { manager, install } = managerWith(reload);
    const c = new AbortController();
    c.abort();
    const sum = await manager.checkForUpdates({ force: true, reload: false, signal: c.signal });
    expect(sum.checked).toBe(0);
    expect(install).not.toHaveBeenCalled();
    delete (globalThis as any).window;
  });
});

describe("app launch wiring (source order)", () => {
  const src = readFileSync("src/renderer/app.ts", "utf8");
  it("runs the before-plugins phase before PluginManager.initialize()", () => {
    const pre = src.indexOf('runLaunchPhase("before-plugins")');
    const init = src.indexOf("this.pluginManager.initialize()");
    const post = src.indexOf('runLaunchPhase("after-plugins")');
    expect(pre).toBeGreaterThan(0);
    expect(pre).toBeLessThan(init);
    expect(init).toBeLessThan(post);
  });
  it("update step opts out of reload and the post-launch auto-update timer is gone", () => {
    expect(src).toMatch(/reload: false/);
    expect(src).not.toContain("communityUpdateTimer");
  });
});
