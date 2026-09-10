import type { GeodeApi } from "../../main/preload";
import type { HostServices, VaultFileEntry } from "./contracts";

export type ElectronPreloadApi = Pick<GeodeApi,
  | "chooseVault" | "openVault" | "getRecentVaults" | "getLaunchVault" | "openVaultWindow"
  | "read" | "readBinary" | "write" | "mkdir" | "trash" | "rename" | "exists" | "reveal" | "onVaultEvent"
  | "readConfig" | "writeConfig" | "readMetadataCache" | "writeMetadataCache"
  | "startMetadataIndexer" | "onMetadataIndexerMessage" | "openExternal" | "openLocalFile"
  | "listPluginIds" | "listThemes" | "readPluginFile" | "replacePluginFiles" | "getPluginPolicy"
  | "getCrashRecoveryState" | "leaveCrashRecovery" | "reportCrashDiagnostic" | "reportActivePlugins"
  | "getWindowChromeState" | "onWindowChromeState" | "onDeepLink" | "setWindowBackgroundColor"
  | "publishHotkeys" | "onGuestHotkey" | "onGuestWindowOpen"
  | "writeBinary"
> & Partial<Pick<GeodeApi,
  "list" | "scanForSync" | "httpRequest" | "cancelHttpRequest" | "claimSyncOwner" | "privateSyncStorage" | "releaseSyncOwner" | "applySyncMutation" | "onSyncPrepare" | "onSyncRelease" | "readDeviceState" | "writeDeviceState" | "removeDeviceState" |
  "isSecretStorageAvailable" | "readSecret" | "writeSecret" | "removeSecret"
>>;

export function createElectronHost(preload: ElectronPreloadApi): HostServices {
  let openFiles: VaultFileEntry[] = [];
  const fallbackDeviceState = new Map<string, unknown>();
  return {
    syncSafety: preload.claimSyncOwner && preload.releaseSyncOwner && preload.applySyncMutation && preload.onSyncPrepare && preload.onSyncRelease ? {
      storage: (token, binding, request) => { if (!preload.privateSyncStorage) throw new Error("Private sync storage unavailable"); return preload.privateSyncStorage(token, binding, request); },
      claimOwner: () => preload.claimSyncOwner!(), releaseOwner: token => preload.releaseSyncOwner!(token), apply: (token, input) => preload.applySyncMutation!(token, input),
      onPrepare: handler => preload.onSyncPrepare!(handler), onRelease: handler => preload.onSyncRelease!(handler),
    } : undefined,
    network: {
      request: async (input, signal) => {
        if (!preload.httpRequest) throw new Error("Host networking unavailable");
        if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
        const id = crypto.randomUUID();
        const cancel = () => preload.cancelHttpRequest?.(id);
        signal?.addEventListener("abort", cancel, { once: true });
        try { const result = await preload.httpRequest(id, input); if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError"); return result; }
        finally { signal?.removeEventListener("abort", cancel); }
      },
    },
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
      list: async () => preload.list?.() ?? openFiles,
      read: (path) => preload.read(path),
      readBinary: (path) => preload.readBinary(path),
      writeBinary: (path, data, options) => preload.writeBinary(path, data, options),
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
      reconcileScan: async () => {
        if (!preload.scanForSync) return { status: "unavailable", entries: [], errorCode: "strict-scan-unavailable" };
        try { return { status: "complete", entries: await preload.scanForSync() }; }
        catch { return { status: "unavailable", entries: [], errorCode: "local-scan-failed" }; }
      },
    },
    deviceState: {
      read: async <T>(key: string) => preload.readDeviceState ? preload.readDeviceState<T>(key) : structuredClone(fallbackDeviceState.get(key) ?? null) as T | null,
      write: async (key, value) => { if (preload.writeDeviceState) await preload.writeDeviceState(key, value); else fallbackDeviceState.set(key, structuredClone(value)); },
      remove: async key => { if (preload.removeDeviceState) await preload.removeDeviceState(key); else fallbackDeviceState.delete(key); },
    },
    secrets: {
      available: preload.isSecretStorageAvailable?.() ?? false,
      fromCapability: (capability) => {
        return {
          get: async key => preload.readSecret ? preload.readSecret(capability, key) : null,
          set: async (key, value) => { if (!preload.writeSecret) throw new Error("Secure secret storage is unavailable"); await preload.writeSecret(capability, key, value); },
          remove: async key => { if (preload.removeSecret) await preload.removeSecret(capability, key); },
        };
      },
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
      onGuestWindowOpen: (cb) => preload.onGuestWindowOpen(cb),
      revealInFileManager: (path) => preload.reveal(path),
    },
  };
}
