import { contextBridge, ipcRenderer } from "electron";

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
  onVaultEvent: (cb: (ev: VaultEvent) => void) => {
    ipcRenderer.on("vault-event", (_e, ev: VaultEvent) => cb(ev));
  },
};

export type GeodeApi = typeof api;

contextBridge.exposeInMainWorld("geode", api);
