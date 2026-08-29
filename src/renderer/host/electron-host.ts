import type { GeodeApi } from "../../main/preload";
import type { HostServices, VaultFileEntry } from "./contracts";

export type ElectronPreloadApi = Pick<GeodeApi,
  | "chooseVault" | "openVault" | "getRecentVaults" | "getLaunchVault" | "openVaultWindow"
  | "read" | "readBinary" | "write" | "mkdir" | "trash" | "rename" | "exists" | "onVaultEvent"
  | "readConfig" | "writeConfig" | "readMetadataCache" | "writeMetadataCache"
  | "startMetadataIndexer" | "onMetadataIndexerMessage" | "openExternal" | "openLocalFile"
  | "listPluginIds" | "listThemes" | "readPluginFile" | "replacePluginFiles" | "getPluginPolicy"
  | "getCrashRecoveryState" | "leaveCrashRecovery" | "reportCrashDiagnostic" | "reportActivePlugins"
  | "getWindowChromeState" | "onWindowChromeState" | "onDeepLink" | "setWindowBackgroundColor"
  | "publishHotkeys" | "onGuestHotkey"
>;

export function createElectronHost(preload: ElectronPreloadApi): HostServices {
  let openFiles: VaultFileEntry[] = [];
  return {
    capabilities: Object.freeze({
      multipleWindows: true,
      nodePlugins: true,
      embeddedWebContent: true,
      externalVaultFolder: true,
      backgroundIndexer: true,
      shareSheet: false,
      threadExecution: true,
      processDiagnostics: true,
      chromeCookieImport: true,
      artifacts: true,
    }),
    runtime: {
      runtime: "electron",
      platform: typeof process === "undefined" ? "unknown" : process.platform,
      formFactor: "desktop",
      getWindowChromeState: () => preload.getWindowChromeState(),
      onWindowChromeState: (cb) => preload.onWindowChromeState(cb),
      onDeepLink: (cb) => preload.onDeepLink(cb),
      onForeground: () => () => {},
    },
    vaultRegistry: {
      chooseVault: () => preload.chooseVault(),
      chooseExternalVault: () => preload.chooseVault(),
      reconnectVault: async () => false,
      checkVault: async () => {},
      describeVault: async (id) => ({ id, name: id.split(/[\\/]/).filter(Boolean).pop() ?? id, kind: "external" }),
      openVault: async (path) => {
        const { root, name, files } = await preload.openVault(path);
        openFiles = files;
        return { root, name };
      },
      getRecentVaults: () => preload.getRecentVaults(),
      getLaunchVault: () => preload.getLaunchVault(),
      closeVault: async () => {},
    },
    vaultFiles: {
      list: async () => openFiles,
      read: (path) => preload.read(path),
      readBinary: (path) => preload.readBinary(path),
      // Electron IPC does not echo renderer-originated mutation IDs, so it's
      // dropped here too — see the `settleMutation` no-op below.
      write: (path, data, options) => preload.write(path, data, options),
      mkdir: (path) => preload.mkdir(path),
      trash: (path) => preload.trash(path),
      rename: (path, newPath) => preload.rename(path, newPath),
      // Electron IPC does not echo renderer-originated mutation IDs.
      settleMutation: async () => {},
      exists: (path) => preload.exists(path),
      onChange: (cb) => preload.onVaultEvent(cb),
      reconcileScan: async () => ({ status: "complete", entries: openFiles }),
    },
    config: {
      read: (name) => preload.readConfig(name),
      write: (name, data) => preload.writeConfig(name, data),
    },
    metadataIndex: {
      readCache: () => preload.readMetadataCache(),
      writeCache: (data) => preload.writeMetadataCache(data),
      startBackgroundIndexer: () => preload.startMetadataIndexer(),
      onMessage: (cb) => preload.onMetadataIndexerMessage(cb),
    },
    navigation: {
      openExternal: (url) => preload.openExternal(url),
      openLocalFile: (href) => preload.openLocalFile(href),
    },
    plugins: {
      listPluginIds: () => preload.listPluginIds(),
      listThemes: () => preload.listThemes(),
      readPluginFile: (path, rendererSentAt) => preload.readPluginFile(path, rendererSentAt),
      replacePluginFiles: (id, expected, replacement) => preload.replacePluginFiles(id, expected, replacement),
      getPolicy: () => preload.getPluginPolicy(),
      getCrashRecoveryState: () => preload.getCrashRecoveryState(),
      leaveCrashRecovery: () => preload.leaveCrashRecovery(),
      reportCrashDiagnostic: (entry) => preload.reportCrashDiagnostic(entry as never),
      reportActivePlugins: (ids) => preload.reportActivePlugins(ids),
    },
    desktop: {
      openVaultWindow: (path) => preload.openVaultWindow(path),
      setWindowBackgroundColor: (color) => preload.setWindowBackgroundColor(color),
      publishHotkeys: (combos) => preload.publishHotkeys(combos),
      onGuestHotkey: (cb) => preload.onGuestHotkey(cb),
    },
  };
}
