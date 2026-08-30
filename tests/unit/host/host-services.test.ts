import { describe, expect, it, vi } from "vitest";
import {
  createBrowserHost,
  createBrowserHostState,
  type BrowserHostStorage,
} from "../../../src/renderer/host/browser-host";
import {
  createElectronHost,
  type ElectronPreloadApi,
} from "../../../src/renderer/host/electron-host";
import { MetadataCache } from "../../../src/renderer/metadata-cache";
import { Vault } from "../../../src/renderer/vault";

function createElectronPreloadFixture(): ElectronPreloadApi {
  return {
    chooseVault: vi.fn(async () => "/vault"),
    openVault: vi.fn(async () => ({
      root: "/vault",
      name: "Vault",
      files: [{ path: "A.md", isFolder: false, mtime: 1, ctime: 1, size: 1 }],
    })),
    getRecentVaults: vi.fn(async () => ["/vault"]),
    getLaunchVault: vi.fn(async () => "/vault"),
    openVaultWindow: vi.fn(async () => ({ action: "created" })),
    read: vi.fn(async () => "A"),
    readBinary: vi.fn(async () => new ArrayBuffer(1)),
    write: vi.fn(async () => ({ mtime: 2, ctime: 1, size: 1 })),
    mkdir: vi.fn(async () => {}),
    trash: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    onVaultEvent: vi.fn(() => () => {}),
    readConfig: vi.fn(async () => null),
    writeConfig: vi.fn(async () => {}),
    readMetadataCache: vi.fn(async () => null),
    writeMetadataCache: vi.fn(async () => {}),
    startMetadataIndexer: vi.fn(async () => true),
    onMetadataIndexerMessage: vi.fn(() => () => {}),
    openExternal: vi.fn(async () => {}),
    openLocalFile: vi.fn(async () => ({ kind: "rejected" })),
    listPluginIds: vi.fn(async () => []),
    listThemes: vi.fn(async () => []),
    readPluginFile: vi.fn(async (_path, sentAt) => ({
      ok: true,
      content: "module.exports = {}",
      mainReceivedAt: sentAt,
      fsStartedAt: sentAt,
      fsFinishedAt: sentAt,
    })),
    replacePluginFiles: vi.fn(async () => {}),
    getPluginPolicy: vi.fn(async () => null),
    getCrashRecoveryState: vi.fn(async () => ({ suppressPlugins: false, entries: [] })),
    leaveCrashRecovery: vi.fn(async () => {}),
    reportCrashDiagnostic: vi.fn(async () => {}),
    reportActivePlugins: vi.fn(async () => {}),
    getWindowChromeState: vi.fn(async () => ({ platform: "darwin", isFullScreen: false })),
    onWindowChromeState: vi.fn(() => () => {}),
    onDeepLink: vi.fn(() => () => {}),
    setWindowBackgroundColor: vi.fn(async () => {}),
    publishHotkeys: vi.fn(async () => {}),
    onGuestHotkey: vi.fn(() => () => {}),
  };
}

describe("HostServices", () => {
  it("atomically replaces the exact browser plugin set including stylesheet absence", async () => {
    const state = createBrowserHostState({ files: {
      ".geode/plugins/probe/manifest.json": "old-manifest",
      ".geode/plugins/probe/main.js": "old-main",
    }});
    const host = createBrowserHost(state);
    await host.vaultRegistry.openVault("managed://default");
    await host.plugins.replacePluginFiles("probe", "old-manifest", {
      manifest: "new-manifest", main: "new-main", styles: "new-css",
    });
    await host.plugins.replacePluginFiles("probe", "new-manifest", {
      manifest: "old-manifest", main: "old-main", styles: null,
    });
    expect(state.files.get(".geode/plugins/probe/manifest.json")?.data).toBe("old-manifest");
    expect(state.files.get(".geode/plugins/probe/main.js")?.data).toBe("old-main");
    expect(state.files.has(".geode/plugins/probe/styles.css")).toBe(false);
  });

  it("forwards atomic plugin replacement through the typed Electron adapter", async () => {
    const preload = createElectronPreloadFixture();
    const host = createElectronHost(preload);
    const replacement = { manifest: "old", main: "main", styles: null };
    await host.plugins.replacePluginFiles("probe", "new", replacement);
    expect(preload.replacePluginFiles).toHaveBeenCalledWith("probe", "new", replacement);
  });
  it("only reports browser foreground when the document becomes visible", () => {
    const documentTarget = new EventTarget() as EventTarget & { visibilityState: string };
    documentTarget.visibilityState = "hidden";
    vi.stubGlobal("document", documentTarget);
    const host = createBrowserHost(createBrowserHostState());
    const callback = vi.fn();
    const stop = host.runtime.onForeground(callback);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(callback).not.toHaveBeenCalled();
    documentTarget.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(callback).toHaveBeenCalledOnce();
    stop();
    vi.unstubAllGlobals();
  });
  it("lists, reads, edits, and restores a managed-vault note", async () => {
    const state = createBrowserHostState({
      vaultName: "Mobile Vault",
      files: { "Welcome.md": "# Welcome\n" },
    });
    const firstBoot = createBrowserHost(state);

    const vault = await firstBoot.vaultRegistry.openVault("managed://default");
    expect(vault).toEqual({ root: "managed://default", name: "Mobile Vault" });
    expect((await firstBoot.vaultFiles.list()).map((entry) => entry.path)).toEqual(["Welcome.md"]);
    expect(await firstBoot.vaultFiles.read("Welcome.md")).toBe("# Welcome\n");

    await firstBoot.vaultFiles.write("Welcome.md", "# Edited on mobile\n");

    const restarted = createBrowserHost(state);
    await restarted.vaultRegistry.openVault("managed://default");
    expect(await restarted.vaultFiles.read("Welcome.md")).toBe("# Edited on mobile\n");
  });

  it("rejects paths that escape the managed vault", async () => {
    const host = createBrowserHost(createBrowserHostState());
    await host.vaultRegistry.openVault("managed://default");

    await expect(host.vaultFiles.write("../outside.md", "nope")).rejects.toThrow("vault-relative");
    await expect(host.vaultFiles.read("/absolute.md")).rejects.toThrow("vault-relative");
    await expect(host.vaultFiles.read("C:\\outside.md")).rejects.toThrow("vault-relative");
    await expect(host.vaultFiles.read("\\\\server\\share.md")).rejects.toThrow("vault-relative");
    await expect(host.vaultFiles.read("Folder/./Note.md")).rejects.toThrow("vault-relative");
    await expect(host.vaultFiles.read("bad\0name.md")).rejects.toThrow("vault-relative");
  });

  it("restores managed-vault files and config from browser storage after state recreation", async () => {
    const values = new Map<string, string>();
    const storage: BrowserHostStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };
    const first = createBrowserHost(createBrowserHostState({ storage }));
    await first.vaultRegistry.openVault("managed://default");
    await first.vaultFiles.write("Reload.md", "survives reload");
    await first.config.write("workspace", { active: "Reload.md" });

    const reloaded = createBrowserHost(createBrowserHostState({ storage }));
    await reloaded.vaultRegistry.openVault("managed://default");
    await expect(reloaded.vaultFiles.read("Reload.md")).resolves.toBe("survives reload");
    await expect(reloaded.config.read("workspace")).resolves.toEqual({ active: "Reload.md" });
  });

  it("rejects a quota-failed proof write without corrupting the last durable snapshot", async () => {
    let durable: string | null = null;
    let rejectWrites = false;
    const storage: BrowserHostStorage = {
      getItem: () => durable,
      setItem: (_key, value) => {
        if (rejectWrites) throw new DOMException("quota", "QuotaExceededError");
        durable = value;
      },
    };
    const first = createBrowserHost(createBrowserHostState({ files: { "Note.md": "durable" }, storage }));
    await first.vaultRegistry.openVault("managed://default");
    rejectWrites = true;

    await expect(first.vaultFiles.write("Note.md", "not durable")).rejects.toThrow("quota");
    rejectWrites = false;
    const reloaded = createBrowserHost(createBrowserHostState({ storage }));
    await reloaded.vaultRegistry.openVault("managed://default");
    await expect(reloaded.vaultFiles.read("Note.md")).resolves.toBe("durable");
  });

  it("renames and trashes folders recursively with descendant events", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: {
      "Folder/A.md": "A",
      "Folder/Nested/B.md": "B",
    } }));
    await host.vaultRegistry.openVault("managed://default");
    await host.vaultFiles.mkdir("Folder");
    await host.vaultFiles.mkdir("Folder/Nested");
    const events: string[] = [];
    host.vaultFiles.onChange((event) => events.push(`${event.event}:${event.path}`));

    await host.vaultFiles.rename("Folder", "Archive");
    expect(await host.vaultFiles.exists("Archive/A.md")).toBe(true);
    expect(await host.vaultFiles.exists("Archive/Nested/B.md")).toBe(true);
    expect(await host.vaultFiles.exists("Folder/A.md")).toBe(false);

    await host.vaultFiles.trash("Archive");
    expect((await host.vaultFiles.list()).filter((entry) => entry.path.startsWith("Archive"))).toEqual([]);
    expect(events).toContain("delete-folder:Folder");
    expect(events).toContain("create-folder:Archive");
    expect(events).toContain("delete:Archive/Nested/B.md");
  });

  it("only opens explicitly safe external URL schemes", async () => {
    const opened: string[] = [];
    const host = createBrowserHost(createBrowserHostState(), { openExternal: (url) => { opened.push(url); } });

    await host.navigation.openExternal("https://example.com/path");
    await host.navigation.openExternal("mailto:hello@example.com");
    await expect(host.navigation.openExternal("javascript:alert(1)")).rejects.toThrow("Unsupported URL scheme");
    await expect(host.navigation.openExternal("data:text/html,unsafe")).rejects.toThrow("Unsupported URL scheme");
    expect(opened).toEqual(["https://example.com/path", "mailto:hello@example.com"]);
  });

  it("exposes an immutable snapshot that gates desktop-only capabilities", () => {
    const host = createBrowserHost(createBrowserHostState());

    expect(host.capabilities.nodePlugins).toBe(false);
    expect(host.capabilities.multipleWindows).toBe(false);
    expect(host.desktop).toBeUndefined();
    expect(Object.isFrozen(host.capabilities)).toBe(true);
    expect(() => {
      (host.capabilities as { nodePlugins: boolean }).nodePlugins = true;
    }).toThrow();
  });

  it("adapts Electron preload operations by responsibility", async () => {
    const preload = createElectronPreloadFixture();
    const disposeVaultListener = vi.fn();
    preload.onVaultEvent = vi.fn(() => disposeVaultListener);
    const host = createElectronHost(preload);

    await expect(host.vaultRegistry.openVault("/vault")).resolves.toEqual({ root: "/vault", name: "Vault" });
    await expect(host.vaultFiles.list()).resolves.toEqual([
      { path: "A.md", isFolder: false, mtime: 1, ctime: 1, size: 1 },
    ]);
    await expect(host.vaultFiles.read("A.md")).resolves.toBe("A");
    await host.config.write("workspace", { version: 1 });
    await host.navigation.openExternal("https://example.com");
    const stop = host.vaultFiles.onChange(() => {});
    stop();
    expect(preload.writeConfig).toHaveBeenCalledWith("workspace", { version: 1 });
    expect(preload.openExternal).toHaveBeenCalledWith("https://example.com");
    expect(preload.onVaultEvent).toHaveBeenCalledOnce();
    expect(disposeVaultListener).toHaveBeenCalledOnce();
    expect(host.capabilities.nodePlugins).toBe(true);
    expect(host.desktop).toBeDefined();
  });

  it("disposes the metadata index listener forwarded through Electron", () => {
    const preload = createElectronPreloadFixture();
    const disposeIndexer = vi.fn();
    preload.onMetadataIndexerMessage = vi.fn(() => disposeIndexer);
    const vault = new Vault(createElectronHost(preload));
    const cache = new MetadataCache(vault);

    cache.dispose();

    expect(preload.onMetadataIndexerMessage).toHaveBeenCalledOnce();
    expect(disposeIndexer).toHaveBeenCalledOnce();
  });
});
