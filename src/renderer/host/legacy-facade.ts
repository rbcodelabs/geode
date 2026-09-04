import type { GeodeApi } from "../../main/preload";
import type { HostServices } from "./contracts";

/** Temporary compatibility surface for renderer/plugin code not migrated in Slice 0. */
export function createLegacyGeodeFacade(host: HostServices): GeodeApi {
  const unavailable = (capability: string) => async () => {
    throw new Error(`Capability is unavailable on this host: ${capability}`);
  };
  return {
    host: { name: "geode", protocolScheme: "geode" },
    acquirePowerSaveBlocker: async () => "unsupported",
    releasePowerSaveBlocker: async () => false,
    chooseVault: () => host.vaultRegistry.chooseVault(),
    openVault: async (path) => ({ ...(await host.vaultRegistry.openVault(path)), files: await host.vaultFiles.list() }),
    getRecentVaults: () => host.vaultRegistry.getRecentVaults(),
    getLaunchVault: () => host.vaultRegistry.getLaunchVault(),
    openVaultWindow: host.desktop?.openVaultWindow ?? unavailable("multipleWindows") as never,
    getPluginPolicy: () => host.plugins.getPolicy() as never,
    getVaultRoot: async () => (await host.vaultRegistry.getLaunchVault()),
    list: () => host.vaultFiles.list(),
    read: (path) => host.vaultFiles.read(path),
    readPluginFile: (path, sent) => host.plugins.readPluginFile(path, sent),
    replacePluginFiles: (id, expected, replacement) => host.plugins.replacePluginFiles(id, expected, replacement),
    readBinary: (path) => host.vaultFiles.readBinary(path),
    write: (path, data) => host.vaultFiles.write(path, data),
    mkdir: (path) => host.vaultFiles.mkdir(path),
    trash: (path) => host.vaultFiles.trash(path),
    rename: (path, newPath) => host.vaultFiles.rename(path, newPath),
    exists: (path) => host.vaultFiles.exists(path),
    readMetadataCache: () => host.metadataIndex.readCache(),
    writeMetadataCache: (data) => host.metadataIndex.writeCache(data),
    startMetadataIndexer: () => host.metadataIndex.startBackgroundIndexer(),
    onMetadataIndexerMessage: ((cb: (message: unknown) => void) => host.metadataIndex.onMessage(cb)) as never,
    readConfig: (name) => host.config.read(name),
    writeConfig: (name, data) => host.config.write(name, data),
    openExternal: (url) => host.navigation.openExternal(url),
    openLocalFile: (href) => host.navigation.openLocalFile(href),
    listPluginIds: () => host.plugins.listPluginIds(),
    listThemes: () => host.plugins.listThemes(),
    resolveCommunity: unavailable("nodePlugins") as never,
    installCommunity: unavailable("nodePlugins") as never,
    importFromObsidian: unavailable("nodePlugins") as never,
    listChromeProfiles: unavailable("chromeCookieImport") as never,
    importChromeCookies: unavailable("chromeCookieImport") as never,
    getProcessMetrics: unavailable("processDiagnostics") as never,
    getFdPressure: unavailable("processDiagnostics") as never,
    getCrashRecoveryState: () => host.plugins.getCrashRecoveryState() as never,
    reportCrashDiagnostic: (entry) => host.plugins.reportCrashDiagnostic(entry),
    reportActivePlugins: (ids) => host.plugins.reportActivePlugins(ids),
    leaveCrashRecovery: () => host.plugins.leaveCrashRecovery(),
    registerArtifact: unavailable("artifacts") as never,
    unregisterArtifact: unavailable("artifacts") as never,
    getArtifactState: unavailable("artifacts") as never,
    captureArtifact: unavailable("artifacts") as never,
    onVaultEvent: ((cb: Parameters<HostServices["vaultFiles"]["onChange"]>[0]) => host.vaultFiles.onChange(cb)) as never,
    onDeepLink: ((cb: Parameters<HostServices["runtime"]["onDeepLink"]>[0]) => host.runtime.onDeepLink(cb)) as never,
    getWindowChromeState: (() => host.runtime.getWindowChromeState()) as never,
    setWindowBackgroundColor: host.desktop?.setWindowBackgroundColor ?? (async () => {}),
    onWindowChromeState: ((cb: Parameters<HostServices["runtime"]["onWindowChromeState"]>[0]) =>
      host.runtime.onWindowChromeState(cb)) as never,
    publishHotkeys: host.desktop?.publishHotkeys ?? (async () => {}),
    onGuestHotkey: (host.desktop?.onGuestHotkey ?? (() => () => {})) as never,
  };
}
