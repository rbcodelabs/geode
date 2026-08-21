import { contextBridge, ipcRenderer } from "electron";
import type { CommunityPreview, InstalledResult, ResolveOpts } from "./github-resolve";
import type { ObsidianImportResult } from "./obsidian-import";
import type { ManagedPolicy } from "../renderer/policy";
import type { ChromeProfile, ChromeCookieImportResult } from "./chrome-cookies";
import type { ProcessMetric } from "./process-metrics";
import type { CrashDiagnostic } from "./crash-journal";

export interface VaultFileEntry {
  path: string;
  isFolder: boolean;
  mtime: number;
  ctime: number;
  size: number;
}

export interface VaultEvent {
  event: "create" | "modify" | "delete" | "create-folder" | "delete-folder";
  path: string;
}

const api = {
  acquirePowerSaveBlocker: (): Promise<string> =>
    ipcRenderer.invoke("power-save-blocker-acquire"),
  releasePowerSaveBlocker: (token: string): Promise<boolean> =>
    ipcRenderer.invoke("power-save-blocker-release", token),
  chooseVault: (): Promise<string | null> => ipcRenderer.invoke("choose-vault"),
  openVault: (
    path: string
  ): Promise<{ root: string; name: string; files: VaultFileEntry[] }> =>
    ipcRenderer.invoke("open-vault", path),
  getRecentVaults: (): Promise<string[]> => ipcRenderer.invoke("get-recent-vaults"),
  getLaunchVault: (): Promise<string | null> => ipcRenderer.invoke("get-launch-vault"),
  openVaultWindow: (path: string): Promise<{ action: "current" | "focused" | "created" }> =>
    ipcRenderer.invoke("open-vault-window", path),
  getPluginPolicy: (): Promise<ManagedPolicy | null> => ipcRenderer.invoke("get-plugin-policy"),
  getVaultRoot: (): Promise<string | null> => ipcRenderer.invoke("get-vault-root"),
  list: (): Promise<VaultFileEntry[]> => ipcRenderer.invoke("vault-list"),
  read: (path: string): Promise<string> => ipcRenderer.invoke("vault-read", path),
  readBinary: (path: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke("vault-read-binary", path),
  write: (path: string, data: string): Promise<{ mtime: number; ctime: number; size: number }> =>
    ipcRenderer.invoke("vault-write", path, data),
  mkdir: (path: string): Promise<void> => ipcRenderer.invoke("vault-mkdir", path),
  trash: (path: string): Promise<void> => ipcRenderer.invoke("vault-delete", path),
  rename: (path: string, newPath: string): Promise<void> =>
    ipcRenderer.invoke("vault-rename", path, newPath),
  exists: (path: string): Promise<boolean> => ipcRenderer.invoke("vault-exists", path),
  readMetadataCache: (): Promise<unknown | null> => ipcRenderer.invoke("metadata-cache-read"),
  writeMetadataCache: (data: unknown): Promise<void> => ipcRenderer.invoke("metadata-cache-write", data),
  startMetadataIndexer: (): Promise<true | null> => ipcRenderer.invoke("metadata-indexer-start"),
  onMetadataIndexerMessage: (cb: (message: any) => void) => {
    ipcRenderer.on("metadata-indexer-message", (_e, message) => cb(message));
  },
  readConfig: (name: string): Promise<unknown> => ipcRenderer.invoke("config-read", name),
  writeConfig: (name: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke("config-write", name, data),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("open-external", url),
  openLocalFile: (href: string): Promise<
    | { kind: "vault"; path: string; line?: number; column?: number }
    | { kind: "external" }
    | { kind: "rejected" }
  > => ipcRenderer.invoke("open-local-file", href),
  listPluginIds: (): Promise<string[]> => ipcRenderer.invoke("plugins-list-ids"),
  listThemes: (): Promise<string[]> => ipcRenderer.invoke("themes-list"),
  resolveCommunity: (spec: string, opts?: ResolveOpts): Promise<CommunityPreview> =>
    ipcRenderer.invoke("community-resolve", spec, opts ?? {}),
  installCommunity: (spec: string, opts?: ResolveOpts): Promise<InstalledResult> =>
    ipcRenderer.invoke("community-install", spec, opts ?? {}),
  importFromObsidian: (): Promise<ObsidianImportResult> =>
    ipcRenderer.invoke("community-import-obsidian"),
  listChromeProfiles: (): Promise<ChromeProfile[]> => ipcRenderer.invoke("chrome-list-profiles"),
  importChromeCookies: (profileDir: string): Promise<ChromeCookieImportResult> =>
    ipcRenderer.invoke("chrome-import-cookies", profileDir),
  getProcessMetrics: (): Promise<ProcessMetric[]> => ipcRenderer.invoke("get-process-metrics"),
  getCrashRecoveryState: (): Promise<{ suppressPlugins: boolean; entries: CrashDiagnostic[] }> =>
    ipcRenderer.invoke("crash-recovery-state"),
  reportCrashDiagnostic: (entry: CrashDiagnostic): Promise<void> =>
    ipcRenderer.invoke("crash-diagnostic", entry),
  reportActivePlugins: (pluginIds: string[]): Promise<void> =>
    ipcRenderer.invoke("crash-active-plugins", pluginIds),
  leaveCrashRecovery: (): Promise<void> => ipcRenderer.invoke("crash-recovery-leave"),
  onVaultEvent: (cb: (ev: VaultEvent) => void) => {
    ipcRenderer.on("vault-event", (_e, ev: VaultEvent) => cb(ev));
  },
};

// A main-process watchdog can distinguish a wedged renderer from a merely
// crashed one. backgroundThrottling is disabled for this window in main.ts.
const heartbeat = setInterval(() => ipcRenderer.send("renderer-heartbeat"), 5_000);
heartbeat.unref?.();
ipcRenderer.send("renderer-heartbeat");

export type GeodeApi = typeof api;

// The renderer runs with contextIsolation disabled (see main.ts's
// webPreferences and the plugin-hosting rationale there), so the
// contextBridge API is unavailable — it throws unless contextIsolation is
// on. In that mode the preload shares the renderer's main world, so we
// attach the API to `window` directly. The `contextBridge` path is kept as
// a fallback in case the window is ever reconfigured with isolation on.
try {
  contextBridge.exposeInMainWorld("geode", api);
} catch {
  (globalThis as unknown as { geode: GeodeApi }).geode = api;
}
