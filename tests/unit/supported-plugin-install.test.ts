import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitSupportedPluginInstall,
  buildSupportedPluginInstallRequest,
} from "../../src/main/supported-plugin-catalog";
import { isMinimumGeodeVersionMet } from "../../src/shared/semver";
import { CommunityManager } from "../../src/renderer/community/community-manager";
import type { SupportedPlugin } from "../../src/main/supported-plugin-catalog";

const plugin: SupportedPlugin = {
  id: "calendar",
  name: "Calendar",
  description: "Calendar view.",
  github: { owner: "liamcain", repo: "obsidian-calendar-plugin" },
  manifest: { version: "1.5.10", releaseTag: "1.5.10", minAppVersion: "0.9.11" },
  platforms: ["desktop"],
  minimumGeodeVersion: "0.2.19",
  certifiedWithGeodeVersion: "0.2.19",
  artifactHashes: { "manifest.json": "a".repeat(64), "main.js": "b".repeat(64) },
  evidenceUrl: `https://github.com/rbcodelabs/geode/blob/${"c".repeat(40)}/tests/e2e/calendar-plugin.spec.ts`,
  status: "active",
};

afterEach(() => { delete (globalThis as any).window; });

describe("supported plugin installation choices", () => {
  it("installs the tested release by default with pinned identity and artifact hashes", async () => {
    const install = vi.fn(async () => ({
      repo: "liamcain/obsidian-calendar-plugin", type: "plugin", id: "calendar", name: "Calendar",
      version: "1.5.10", minAppVersion: "0.9.11", source: "release", ref: "1.5.10",
    }));

    const request = buildSupportedPluginInstallRequest(plugin, "tested");
    await install(request.repo, request.options);

    expect(install).toHaveBeenCalledWith("liamcain/obsidian-calendar-plugin", {
      type: "plugin",
      tag: "1.5.10",
      expected: {
        repo: "liamcain/obsidian-calendar-plugin",
        type: "plugin",
        id: "calendar",
        name: "Calendar",
        version: "1.5.10",
        minAppVersion: "0.9.11",
        source: "release",
        ref: "1.5.10",
        artifactHashes: plugin.artifactHashes,
      },
    });
  });

  it("uses ordinary GitHub resolution for an explicitly selected latest release", async () => {
    const install = vi.fn(async () => ({
      repo: "liamcain/obsidian-calendar-plugin", type: "plugin", id: "calendar", name: "Calendar",
      version: "1.6.0", minAppVersion: "0.9.11", source: "release", ref: "1.6.0",
    }));

    const request = buildSupportedPluginInstallRequest(plugin, "latest");
    await install(request.repo, request.options);

    expect(install).toHaveBeenCalledWith("liamcain/obsidian-calendar-plugin", { type: "plugin" });
  });
});

describe("CommunityManager catalog install", () => {
  it("records a tested catalog install pinned to its certified manifest version", async () => {
    const installed = {
      repo: "liamcain/obsidian-calendar-plugin", type: "plugin" as const, id: "calendar", name: "Calendar",
      version: "1.5.10", minAppVersion: "0.9.11", source: "release" as const, ref: "1.5.10",
    };
    const installCatalogPlugin = vi.fn(async () => installed);
    const writeConfig = vi.fn(async () => {});
    (globalThis as any).window = { geode: {
      installSupportedPlugin: installCatalogPlugin,
      readConfig: vi.fn(async () => null),
      writeConfig,
    } };
    const rescan = vi.fn(async () => {});
    const manager = new CommunityManager({ pluginManager: { rescan } } as any);

    await expect(manager.installSupported("calendar", "tested")).resolves.toEqual(installed);
    expect(installCatalogPlugin).toHaveBeenCalledWith("calendar", "tested");
    expect(writeConfig).toHaveBeenCalledWith("community", expect.objectContaining({
      items: [expect.objectContaining({
        id: "calendar",
        installedVersion: "1.5.10",
        pinnedVersion: "1.5.10",
      })],
    }));
    expect(rescan).toHaveBeenCalledOnce();
  });

  it("records an explicitly selected latest catalog install as unpinned", async () => {
    const installed = {
      repo: "liamcain/obsidian-calendar-plugin", type: "plugin" as const, id: "calendar", name: "Calendar",
      version: "1.6.0", minAppVersion: "0.9.11", source: "release" as const, ref: "1.6.0",
    };
    const installCatalogPlugin = vi.fn(async () => installed);
    const writeConfig = vi.fn(async () => {});
    (globalThis as any).window = { geode: {
      installSupportedPlugin: installCatalogPlugin,
      readConfig: vi.fn(async () => null),
      writeConfig,
    } };
    const manager = new CommunityManager({ pluginManager: { rescan: vi.fn(async () => {}) } } as any);

    await manager.installSupported("calendar", "latest");

    expect(installCatalogPlugin).toHaveBeenCalledWith("calendar", "latest");
    const written = writeConfig.mock.calls[0][1] as { items: Array<Record<string, unknown>> };
    expect(written.items[0]).toMatchObject({ id: "calendar", installedVersion: "1.6.0" });
    expect(written.items[0]).not.toHaveProperty("pinnedVersion");
  });
});

describe("minimum Geode version admission", () => {
  it.each([
    ["0.13.4", "0.2.19", true],
    ["0.2.19", "0.2.19", true],
    ["0.2.18", "0.2.19", false],
    ["1.0.0-beta.2", "1.0.0", false],
    ["1.0.0", "1.0.0-beta.2", true],
    ["1.0.0-100000000000000000000", "1.0.0-99999999999999999999", true],
    ["1.0.0-99999999999999999999", "1.0.0-100000000000000000000", false],
    ["9007199254740993.0.0", "9007199254740992.0.0", true],
    ["9007199254740992.0.0", "9007199254740993.0.0", false],
  ])("compares %s against %s", (current, minimum, compatible) => {
    expect(isMinimumGeodeVersionMet(current, minimum)).toBe(compatible);
  });
});

describe("main-process supported catalog admission policy", () => {
  const catalog = { schemaVersion: 1 as const, plugins: [plugin] };

  it("admits an active desktop entry whose minimum version is met", () => {
    expect(admitSupportedPluginInstall(catalog, "calendar", "tested", "0.14.0")).toEqual(
      buildSupportedPluginInstallRequest(plugin, "tested"),
    );
  });

  it.each([
    ["missing entry", catalog, "missing", "0.14.0", /not available/],
    ["withdrawn entry", { ...catalog, plugins: [{ ...plugin, status: "withdrawn" as const }] }, "calendar", "0.14.0", /not available/],
    ["mobile-only entry", { ...catalog, plugins: [{ ...plugin, platforms: ["mobile" as const] }] }, "calendar", "0.14.0", /not available/],
    ["too-new entry", { ...catalog, plugins: [{ ...plugin, minimumGeodeVersion: "99.0.0" }] }, "calendar", "0.14.0", /requires Geode 99\.0\.0/],
  ])("rejects a %s", (_label, candidate, id, current, error) => {
    expect(() => admitSupportedPluginInstall(candidate, id, "tested", current)).toThrow(error);
  });
});
