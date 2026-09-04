import { registerPlugin, type Plugin, type PluginListenerHandle } from "@capacitor/core";
import { VaultAccessError, type HostServices, type VaultAccessState, type VaultEvent, type VaultFileEntry } from "./contracts";
import type { PluginFileSet } from "./contracts";

type EmptyResult = Record<string, never>;

export interface ManagedVaultPlugin extends Plugin {
  chooseExternalVault(): Promise<{ id: string | null }>;
  reconnectVault(options: { id: string }): Promise<{ reconnected: boolean }>;
  describeVault(options: { id: string }): Promise<{ id: string; name: string; kind: "managed" | "external" }>;
  checkVault(options: { id: string }): Promise<EmptyResult>;
  openVault(options: { id: string }): Promise<{ id: string; name: string; kind: "managed" | "external"; status: "ready" | "stale-refreshed" }>;
  getRecentVaults(): Promise<{ ids: string[] }>;
  getLaunchVault(): Promise<{ id: string | null }>;
  closeVault(): Promise<EmptyResult>;
  list(): Promise<{ entries: VaultFileEntry[] }>;
  read(options: { path: string }): Promise<{ data: string }>;
  readBinary(options: { path: string }): Promise<{ base64: string }>;
  write(options: { path: string; data: string; mutationId?: string }): Promise<{ mtime: number; ctime: number; size: number }>;
  mkdir(options: { path: string; mutationId?: string }): Promise<EmptyResult>;
  trash(options: { path: string; mutationId?: string }): Promise<EmptyResult>;
  rename(options: { path: string; newPath: string; mutationId?: string }): Promise<EmptyResult>;
  settleMutation(options: { mutationId: string }): Promise<EmptyResult>;
  exists(options: { path: string }): Promise<{ exists: boolean }>;
  listPluginIds(): Promise<{ ids: string[] }>;
  listThemes(): Promise<{ ids: string[] }>;
  readPluginFile(options: { path: string; maxBytes: number }): Promise<{ content: string }>;
  replacePluginFiles(options: { id: string; expectedManifest: string; replacement: PluginFileSet }): Promise<EmptyResult>;
  addListener(eventName: "change", listenerFunc: (event: VaultEvent) => void): Promise<PluginListenerHandle>;
}

export const GeodeManagedVault = registerPlugin<ManagedVaultPlugin>("GeodeManagedVault");

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function managedVaultPath(path: string): string {
  if (path.includes("\0") || path.includes("\\") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`Expected a vault-relative path: ${path}`);
  }
  const normalized = path;
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || parts[0] === ".geode-trash" ||
      parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Expected a vault-relative path: ${path}`);
  }
  return normalized;
}

function vaultAccessError(error: unknown, id: string): never {
  const native = error as { code?: string; data?: Record<string, unknown>; id?: string; name?: string; state?: string; message?: string };
  const data = native.data ?? native;
  const state = data.state;
  if (native.code?.startsWith("VAULT_") &&
      (state === "unavailable" || state === "permission-revoked" || state === "missing")) {
    throw new VaultAccessError(
      native.message ?? "Vault access is unavailable",
      native.code,
      String(data.id ?? id),
      String(data.name ?? id),
      state as VaultAccessState,
    );
  }
  throw error;
}

export function createCapacitorHost(plugin: ManagedVaultPlugin, portable: HostServices): HostServices {
  let opened = false;
  const requireOpen = () => {
    if (!opened) throw new Error("No managed vault is open");
  };
  const formFactor = typeof window !== "undefined" && window.matchMedia?.("(min-width: 701px)").matches
    ? "tablet" as const
    : "phone" as const;

  return {
    ...portable,
    capabilities: Object.freeze({ ...portable.capabilities, externalVaultFolder: true }),
    runtime: {
      runtime: "ios",
      platform: "ios",
      formFactor,
      getWindowChromeState: async () => ({ platform: "ios", isFullScreen: true }),
      onWindowChromeState: () => () => {},
      onDeepLink: portable.runtime.onDeepLink,
      onForeground: portable.runtime.onForeground,
    },
    vaultRegistry: {
      chooseVault: async () => "managed://default",
      chooseExternalVault: async () => (await plugin.chooseExternalVault()).id,
      reconnectVault: async (id) => (await plugin.reconnectVault({ id })).reconnected,
      describeVault: (id) => plugin.describeVault({ id }),
      checkVault: async (id) => {
        try { await plugin.checkVault({ id }); }
        catch (error) { vaultAccessError(error, id); }
      },
      openVault: async (path) => {
        try {
          const result = await plugin.openVault({ id: path });
          opened = true;
          return { root: result.id, name: result.name };
        } catch (error) {
          vaultAccessError(error, path);
        }
      },
      getRecentVaults: async () => (await plugin.getRecentVaults()).ids,
      getLaunchVault: async () => (await plugin.getLaunchVault()).id,
      closeVault: async () => {
        opened = false;
        await plugin.closeVault();
      },
    },
    vaultFiles: {
      list: async () => {
        requireOpen();
        return (await plugin.list()).entries;
      },
      read: async (path) => {
        requireOpen();
        return (await plugin.read({ path: managedVaultPath(path) })).data;
      },
      readBinary: async (path) => {
        requireOpen();
        return decodeBase64((await plugin.readBinary({ path: managedVaultPath(path) })).base64);
      },
      // The native plugin does not yet accept mtime/ctime overrides; writeOptions
      // is accepted for interface compatibility with the other hosts but not
      // threaded through, matching this PR's Electron-only scope.
      write: async (path, data, _writeOptions, mutationId) => {
        requireOpen();
        return plugin.write({ path: managedVaultPath(path), data, mutationId });
      },
      mkdir: async (path, mutationId) => {
        requireOpen();
        await plugin.mkdir({ path: managedVaultPath(path), mutationId });
      },
      trash: async (path, mutationId) => {
        requireOpen();
        await plugin.trash({ path: managedVaultPath(path), mutationId });
      },
      rename: async (path, newPath, mutationId) => {
        requireOpen();
        await plugin.rename({ path: managedVaultPath(path), newPath: managedVaultPath(newPath), mutationId });
      },
      settleMutation: async (mutationId) => {
        requireOpen();
        await plugin.settleMutation({ mutationId });
      },
      exists: async (path) => {
        requireOpen();
        return (await plugin.exists({ path: managedVaultPath(path) })).exists;
      },
      onChange: (callback) => {
        let disposed = false;
        let handle: PluginListenerHandle | undefined;
        void plugin.addListener("change", callback).then((registered) => {
          handle = registered;
          if (disposed) void handle.remove();
        }).catch(() => {
          // A failed native listener registration leaves a valid, inert disposer.
        });
        return () => {
          disposed = true;
          if (handle) void handle.remove();
        };
      },
      reconcileScan: async () => {
        requireOpen();
        try {
          return { status: "complete", entries: (await plugin.list()).entries };
        } catch (error) {
          const native = error as { code?: string };
          if (native.code === "CONTENT_UNAVAILABLE" || native.code?.startsWith("VAULT_")) {
            return { status: "unavailable", entries: [], errorCode: native.code };
          }
          throw error;
        }
      },
    },
    plugins: {
      listPluginIds: async () => (await plugin.listPluginIds()).ids,
      listThemes: async () => (await plugin.listThemes()).ids,
      readPluginFile: async (path, rendererSentAt) => {
        const started = Date.now();
        try {
          const { content } = await plugin.readPluginFile({ path, maxBytes: 16 * 1024 * 1024 });
          return { ok: true, content, mainReceivedAt: rendererSentAt, fsStartedAt: started, fsFinishedAt: Date.now() };
        } catch (error) {
          return {
            ok: false,
            errorCode: (error as { code?: string }).code ?? "PLUGIN_READ_FAILED",
            mainReceivedAt: rendererSentAt,
            fsStartedAt: started,
            fsFinishedAt: Date.now(),
          };
        }
      },
      replacePluginFiles: async (id, expectedManifest, replacement) => {
        await plugin.replacePluginFiles({ id, expectedManifest, replacement });
      },
      getPolicy: async () => null,
      getCrashRecoveryState: portable.plugins.getCrashRecoveryState,
      leaveCrashRecovery: portable.plugins.leaveCrashRecovery,
      reportCrashDiagnostic: portable.plugins.reportCrashDiagnostic,
      reportActivePlugins: portable.plugins.reportActivePlugins,
    },
  };
}
