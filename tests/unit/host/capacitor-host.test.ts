import { describe, expect, it, vi } from "vitest";
import { createBrowserHost, createBrowserHostState } from "../../../src/renderer/host/browser-host";
import {
  createCapacitorHost,
  type ManagedVaultPlugin,
} from "../../../src/renderer/host/capacitor-host";
import { DataAdapter, FileSystemAdapter } from "../../../src/renderer/types";
import { Vault } from "../../../src/renderer/vault";

function pluginFixture(): ManagedVaultPlugin {
  return {
    chooseExternalVault: vi.fn(async () => ({ id: null })),
    reconnectVault: vi.fn(async () => ({ reconnected: false })),
    describeVault: vi.fn(async ({ id }) => ({ id, name: id === "managed://default" ? "Geode Mobile" : "Provider Vault", kind: id === "managed://default" ? "managed" as const : "external" as const })),
    checkVault: vi.fn(async () => ({})),
    openVault: vi.fn(async ({ id } = { id: "managed://default" }) => ({ id, name: id === "managed://default" ? "Geode Mobile" : "Provider Vault", kind: id === "managed://default" ? "managed" as const : "external" as const, status: "ready" as const })),
    getRecentVaults: vi.fn(async () => ({ ids: ["managed://default"] })),
    getLaunchVault: vi.fn(async () => ({ id: "managed://default" as string | null })),
    closeVault: vi.fn(async () => ({})),
    list: vi.fn(async () => ({ entries: [{ path: "Welcome.md", isFolder: false, mtime: 2, ctime: 1, size: 7 }] })),
    read: vi.fn(async () => ({ data: "welcome" })),
    readBinary: vi.fn(async () => ({ base64: "AAEC/w==" })),
    write: vi.fn(async () => ({ mtime: 3, ctime: 1, size: 6 })),
    mkdir: vi.fn(async () => ({})),
    trash: vi.fn(async () => ({})),
    rename: vi.fn(async () => ({})),
    exists: vi.fn(async () => ({ exists: true })),
    listPluginIds: vi.fn(async () => ({ ids: ["mobile-probe"] })),
    listThemes: vi.fn(async () => ({ ids: ["mobile-theme"] })),
    readPluginFile: vi.fn(async () => ({ content: "module.exports = class {}" })),
    replacePluginFiles: vi.fn(async () => ({})),
    settleMutation: vi.fn(async () => ({})),
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })),
  };
}

describe("CapacitorHostServices", () => {
  it("routes plugin discovery, bounded reads, and atomic replacement through the active native root", async () => {
    const plugin = pluginFixture();
    const portable = createBrowserHost(createBrowserHostState());
    const host = createCapacitorHost(plugin, portable);
    await host.vaultRegistry.openVault("managed://default");
    await expect(host.plugins.listPluginIds()).resolves.toEqual(["mobile-probe"]);
    await expect(host.plugins.listThemes()).resolves.toEqual(["mobile-theme"]);
    await expect(host.plugins.readPluginFile(".geode/plugins/mobile-probe/main.js", 10)).resolves.toMatchObject({
      ok: true, content: "module.exports = class {}",
    });
    const replacement = { manifest: "old", main: "main", styles: null };
    await host.plugins.replacePluginFiles("mobile-probe", "new", replacement);
    expect(plugin.readPluginFile).toHaveBeenCalledWith({ path: ".geode/plugins/mobile-probe/main.js", maxBytes: 16 * 1024 * 1024 });
    expect(plugin.replacePluginFiles).toHaveBeenCalledWith({ id: "mobile-probe", expectedManifest: "new", replacement });
  });
  it("maps the managed vault without exposing an absolute container path", async () => {
    const plugin = pluginFixture();
    const host = createCapacitorHost(plugin, createBrowserHost(createBrowserHostState()));

    expect(host.runtime.runtime).toBe("ios");
    expect(host.capabilities.externalVaultFolder).toBe(true);
    await expect(host.vaultRegistry.openVault("managed://default")).resolves.toEqual({
      root: "managed://default",
      name: "Geode Mobile",
    });
    await expect(host.vaultFiles.list()).resolves.toEqual([
      { path: "Welcome.md", isFolder: false, mtime: 2, ctime: 1, size: 7 },
    ]);
  });

  it("selects and reopens only opaque external vault identities", async () => {
    const plugin = pluginFixture();
    plugin.chooseExternalVault = vi.fn(async () => ({ id: "external://stable-id" }));
    plugin.getRecentVaults = vi.fn(async () => ({ ids: ["external://stable-id", "managed://default"] }));
    const host = createCapacitorHost(plugin, createBrowserHost(createBrowserHostState()));

    await expect(host.vaultRegistry.chooseExternalVault()).resolves.toBe("external://stable-id");
    await expect(host.vaultRegistry.getRecentVaults()).resolves.toEqual(["external://stable-id", "managed://default"]);
    await expect(host.vaultRegistry.describeVault("external://stable-id")).resolves.toEqual({
      id: "external://stable-id", name: "Provider Vault", kind: "external",
    });
    await expect(host.vaultRegistry.checkVault("external://stable-id")).resolves.toBeUndefined();
    expect(plugin.checkVault).toHaveBeenCalledWith({ id: "external://stable-id" });
    await expect(host.vaultRegistry.openVault("external://stable-id")).resolves.toEqual({
      root: "external://stable-id", name: "Provider Vault",
    });
    expect(JSON.stringify(plugin.openVault.mock.calls)).not.toContain("file://");
  });

  it("keeps picker cancellation and recoverable open failures explicit", async () => {
    const plugin = pluginFixture();
    const host = createCapacitorHost(plugin, createBrowserHost(createBrowserHostState()));
    await expect(host.vaultRegistry.chooseExternalVault()).resolves.toBeNull();
    await expect(host.vaultRegistry.reconnectVault("external://stable-id")).resolves.toBe(false);

    plugin.openVault = vi.fn(async () => {
      throw Object.assign(new Error("Vault access is unavailable"), {
        code: "VAULT_MISSING", data: { id: "external://stable-id", name: "Provider Vault", state: "missing" },
      });
    });
    await expect(host.vaultRegistry.openVault("external://stable-id")).rejects.toMatchObject({
      code: "VAULT_MISSING", vaultId: "external://stable-id", vaultName: "Provider Vault", state: "missing",
    });
  });

  it("maps recoverable access checks without activating the target vault", async () => {
    const plugin = pluginFixture();
    plugin.checkVault = vi.fn(async () => {
      throw Object.assign(new Error("Missing provider"), {
        code: "VAULT_MISSING", data: { id: "external://missing", name: "Missing", state: "missing" },
      });
    });
    const host = createCapacitorHost(plugin, createBrowserHost(createBrowserHostState()));
    await host.vaultRegistry.openVault("managed://default");

    await expect(host.vaultRegistry.checkVault("external://missing")).rejects.toMatchObject({
      code: "VAULT_MISSING", vaultId: "external://missing", state: "missing",
    });
    expect(plugin.openVault).toHaveBeenCalledTimes(1);
    await expect(host.vaultFiles.read("Welcome.md")).resolves.toBe("welcome");
  });

  it("keeps the current vault usable when an in-window external switch fails", async () => {
    const plugin = pluginFixture();
    const host = createCapacitorHost(plugin, createBrowserHost(createBrowserHostState()));
    await host.vaultRegistry.openVault("managed://default");
    plugin.openVault = vi.fn(async () => {
      throw Object.assign(new Error("Missing provider"), {
        code: "VAULT_MISSING", data: { id: "external://missing", name: "Missing", state: "missing" },
      });
    });

    await expect(host.vaultRegistry.openVault("external://missing")).rejects.toMatchObject({ code: "VAULT_MISSING" });
    await expect(host.vaultFiles.read("Welcome.md")).resolves.toBe("welcome");
  });

  it("round-trips text, binary, and mutation ids through the native plugin", async () => {
    const plugin = pluginFixture();
    const host = createCapacitorHost(plugin, createBrowserHost(createBrowserHostState()));
    await host.vaultRegistry.openVault("managed://default");

    await expect(host.vaultFiles.read("Welcome.md")).resolves.toBe("welcome");
    expect([...new Uint8Array(await host.vaultFiles.readBinary("asset.bin"))]).toEqual([0, 1, 2, 255]);
    await host.vaultFiles.write("Welcome.md", "edited", undefined, "mutation-1");
    await host.vaultFiles.mkdir("Folder", "mutation-2");
    await host.vaultFiles.rename("Folder", "Archive", "mutation-3");
    await host.vaultFiles.trash("Archive", "mutation-4");
    await host.vaultFiles.settleMutation("mutation-4");

    expect(plugin.write).toHaveBeenCalledWith({ path: "Welcome.md", data: "edited", mutationId: "mutation-1" });
    expect(plugin.mkdir).toHaveBeenCalledWith({ path: "Folder", mutationId: "mutation-2" });
    expect(plugin.rename).toHaveBeenCalledWith({ path: "Folder", newPath: "Archive", mutationId: "mutation-3" });
    expect(plugin.trash).toHaveBeenCalledWith({ path: "Archive", mutationId: "mutation-4" });
    expect(plugin.settleMutation).toHaveBeenCalledWith({ mutationId: "mutation-4" });
  });

  it("forwards native mutation events and disposes listeners registered asynchronously", async () => {
    let listener: ((event: { event: "modify"; path: string; mutationId?: string }) => void) | undefined;
    const remove = vi.fn(async () => {});
    const plugin = pluginFixture();
    plugin.addListener = vi.fn(async (_name, callback) => {
      listener = callback;
      return { remove };
    });
    const host = createCapacitorHost(plugin, createBrowserHost(createBrowserHostState()));
    const received = vi.fn();

    const dispose = host.vaultFiles.onChange(received);
    await Promise.resolve();
    listener?.({ event: "modify", path: "Welcome.md", mutationId: "mutation-1" });
    dispose();
    await Promise.resolve();

    expect(received).toHaveBeenCalledWith({ event: "modify", path: "Welcome.md", mutationId: "mutation-1" });
    expect(remove).toHaveBeenCalledOnce();
  });

  it("rejects unsafe paths before they cross the native bridge", async () => {
    const plugin = pluginFixture();
    const host = createCapacitorHost(plugin, createBrowserHost(createBrowserHostState()));
    await host.vaultRegistry.openVault("managed://default");

    for (const path of ["../escape.md", "/absolute.md", "Folder/./Note.md", "Folder\\Note.md", "C:\\escape.md", "\\\\server\\share.md", ".geode-trash/item"] ) {
      await expect(host.vaultFiles.read(path)).rejects.toThrow("vault-relative");
    }
    expect(plugin.read).not.toHaveBeenCalled();
  });

  it("retains an honest non-filesystem DataAdapter identity", async () => {
    const host = createCapacitorHost(pluginFixture(), createBrowserHost(createBrowserHostState()));
    const vault = new Vault(host);
    await vault.open("managed://default");

    expect(vault.adapter).toBeInstanceOf(DataAdapter);
    expect(vault.adapter).not.toBeInstanceOf(FileSystemAdapter);
    expect("getBasePath" in vault.adapter).toBe(false);
  });

  it("contains native listener registration rejection", async () => {
    const plugin = pluginFixture();
    plugin.addListener = vi.fn(async () => { throw new Error("registration failed"); });
    const host = createCapacitorHost(plugin, createBrowserHost(createBrowserHostState()));

    const dispose = host.vaultFiles.onChange(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispose();
  });

  it("uses the native authoritative list for complete reconciliation scans", async () => {
    const plugin = pluginFixture();
    const host = createCapacitorHost(plugin, createBrowserHost(createBrowserHostState()));
    await host.vaultRegistry.openVault("managed://default");

    await expect(host.vaultFiles.reconcileScan()).resolves.toEqual({
      status: "complete",
      entries: [{ path: "Welcome.md", isFolder: false, mtime: 2, ctime: 1, size: 7 }],
    });
  });

  it.each(["CONTENT_UNAVAILABLE", "VAULT_PERMISSION_REVOKED"])(
    "maps native %s scans to a recoverable unavailable result without false entries",
    async (code) => {
      const plugin = pluginFixture();
      plugin.list = vi.fn(async () => { throw Object.assign(new Error(code), { code }); });
      const host = createCapacitorHost(plugin, createBrowserHost(createBrowserHostState()));
      await host.vaultRegistry.openVault("managed://default");

      await expect(host.vaultFiles.reconcileScan()).resolves.toEqual({ status: "unavailable", entries: [], errorCode: code });
    },
  );
});
