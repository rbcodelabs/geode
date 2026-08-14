import { contextBridge, ipcRenderer } from "electron";
import type { CommunityPreview, InstalledResult, ResolveOpts } from "./github-resolve";
import type { ChromeProfile, ChromeCookieImportResult } from "./chrome-cookies";

export interface VaultFileEntry {
  path: string;
  isFolder: boolean;
  mtime: number;
  size: number;
}

export interface VaultEvent {
  event: "create" | "modify" | "delete" | "create-folder" | "delete-folder";
  path: string;
}

const api = {
  chooseVault: (): Promise<string | null> => ipcRenderer.invoke("choose-vault"),
  openVault: (
    path: string
  ): Promise<{ root: string; name: string; files: VaultFileEntry[] }> =>
    ipcRenderer.invoke("open-vault", path),
  getRecentVaults: (): Promise<string[]> => ipcRenderer.invoke("get-recent-vaults"),
  getVaultRoot: (): Promise<string | null> => ipcRenderer.invoke("get-vault-root"),
  list: (): Promise<VaultFileEntry[]> => ipcRenderer.invoke("vault-list"),
  read: (path: string): Promise<string> => ipcRenderer.invoke("vault-read", path),
  readBinary: (path: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke("vault-read-binary", path),
  write: (path: string, data: string): Promise<{ mtime: number; size: number }> =>
    ipcRenderer.invoke("vault-write", path, data),
  mkdir: (path: string): Promise<void> => ipcRenderer.invoke("vault-mkdir", path),
  trash: (path: string): Promise<void> => ipcRenderer.invoke("vault-delete", path),
  rename: (path: string, newPath: string): Promise<void> =>
    ipcRenderer.invoke("vault-rename", path, newPath),
  exists: (path: string): Promise<boolean> => ipcRenderer.invoke("vault-exists", path),
  readConfig: (name: string): Promise<unknown> => ipcRenderer.invoke("config-read", name),
  writeConfig: (name: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke("config-write", name, data),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("open-external", url),
  listPluginIds: (): Promise<string[]> => ipcRenderer.invoke("plugins-list-ids"),
  listThemes: (): Promise<string[]> => ipcRenderer.invoke("themes-list"),
  resolveCommunity: (spec: string, opts?: ResolveOpts): Promise<CommunityPreview> =>
    ipcRenderer.invoke("community-resolve", spec, opts ?? {}),
  installCommunity: (spec: string, opts?: ResolveOpts): Promise<InstalledResult> =>
    ipcRenderer.invoke("community-install", spec, opts ?? {}),
  listChromeProfiles: (): Promise<ChromeProfile[]> => ipcRenderer.invoke("chrome-list-profiles"),
  importChromeCookies: (profileDir: string): Promise<ChromeCookieImportResult> =>
    ipcRenderer.invoke("chrome-import-cookies", profileDir),
  onVaultEvent: (cb: (ev: VaultEvent) => void) => {
    ipcRenderer.on("vault-event", (_e, ev: VaultEvent) => cb(ev));
  },
};

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
