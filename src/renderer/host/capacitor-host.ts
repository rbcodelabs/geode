import { registerPlugin, type Plugin, type PluginListenerHandle } from "@capacitor/core";
import { VaultAccessError, type HostServices, type VaultAccessState, type VaultEvent, type VaultFileEntry } from "./contracts";
import type { PluginFileSet } from "./contracts";
import { assertValidThemeId } from "../../shared/theme-id";
import type { SyncVaultPathIssue } from "../../sync-core/ports";
import { SyncBlockedError } from "../../sync-core/ports";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { createMobileSyncSafety, type MobileSyncPorts, type NativeStat } from "./mobile-sync-safety";

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
  writeBinary?(options: { path: string; base64: string; mutationId?: string }): Promise<{ mtime: number; ctime: number; size: number }>;
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
  /**
   * Guarded-sync primitives (all optional so an older native build simply has no `host.syncSafety`).
   * `stat` never follows or resolves links: a link anywhere on the path is reported as "symlink".
   */
  stat?(options: { path: string }): Promise<NativeStat>;
  /** App-sandbox storage outside every vault (Application Support, excluded from backup). Relative, `/`-separated paths. */
  syncPrivateWrite?(options: { path: string; base64: string }): Promise<EmptyResult>;
  syncPrivateRead?(options: { path: string }): Promise<{ found: boolean; base64?: string }>;
  syncPrivateList?(options: { path: string }): Promise<{ entries: Array<{ name: string; isFolder: boolean }> }>;
  syncPrivateRemove?(options: { path: string; recursive: boolean }): Promise<EmptyResult>;
  syncPrivateAvailableBytes?(): Promise<{ bytes: number }>;
  /** Keychain (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly) under Geode's own service namespace. */
  appSecretGet?(options: { key: string }): Promise<{ found: boolean; value?: string }>;
  appSecretSet?(options: { key: string; value: string }): Promise<EmptyResult>;
  appSecretRemove?(options: { key: string }): Promise<EmptyResult>;
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

const ICLOUD_STUB = /^\.(.+)\.icloud$/;

/**
 * Splits a native listing into real entries and iCloud placeholders. A `.name.icloud` file stands in for a
 * file that exists but is not on this device; left alone it would simply be absent and the engine would read
 * that as "deleted". It is reported as blocked (untouchable, never downloaded by Geode) at the real file's path.
 */
export function splitICloudPlaceholders(entries: VaultFileEntry[]): { entries: VaultFileEntry[]; blocked: SyncVaultPathIssue[] } {
  const paths = new Set(entries.map((entry) => entry.path));
  const blocked: SyncVaultPathIssue[] = [];
  const real: VaultFileEntry[] = [];
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf("/");
    const stub = entry.isFolder ? null : ICLOUD_STUB.exec(entry.path.slice(slash + 1));
    if (!stub) { real.push(entry); continue; }
    const actual = entry.path.slice(0, slash + 1) + stub[1];
    if (!paths.has(actual)) blocked.push({ path: actual, reason: "icloud-not-downloaded" });
  }
  return { entries: real, blocked };
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

/** Guarded sync over the native plugin; absent (so history sync stays refused) when the native build lacks the primitives. */
function createCapacitorSyncSafety(plugin: ManagedVaultPlugin, portable: HostServices, rootId: () => string | null): HostServices["syncSafety"] {
  const { stat, writeBinary, syncPrivateWrite, syncPrivateRead, syncPrivateList, syncPrivateRemove } = plugin;
  if (!stat || !writeBinary || !syncPrivateWrite || !syncPrivateRead || !syncPrivateList || !syncPrivateRemove) return undefined;
  const ports: MobileSyncPorts = {
    rootId,
    vault: {
      stat: (path) => stat.call(plugin, { path: managedVaultPath(path) }),
      readBinary: async (path) => decodeBase64((await plugin.readBinary({ path: managedVaultPath(path) })).base64),
      writeBinary: async (path, data, mutationId) => { await writeBinary.call(plugin, { path: managedVaultPath(path), base64: bytesToBase64(new Uint8Array(data)), mutationId }); },
      mkdir: async (path, mutationId) => { await plugin.mkdir({ path: managedVaultPath(path), mutationId }); },
      trash: async (path, mutationId) => { await plugin.trash({ path: managedVaultPath(path), mutationId }); },
    },
    privateStore: {
      write: async (path, data) => { await syncPrivateWrite.call(plugin, { path, base64: bytesToBase64(data) }); },
      read: async (path) => { const result = await syncPrivateRead.call(plugin, { path }); return result.found && result.base64 !== undefined ? base64ToBytes(result.base64) : null; },
      list: async (path) => (await syncPrivateList.call(plugin, { path })).entries,
      remove: async (path, recursive) => { await syncPrivateRemove.call(plugin, { path, recursive }); },
      availableBytes: async () => plugin.syncPrivateAvailableBytes ? (await plugin.syncPrivateAvailableBytes()).bytes : null,
    },
    config: portable.config,
  };
  return createMobileSyncSafety(ports);
}

/** Geode's own secrets (the hub token) in the iOS Keychain. Never in device state, the vault, or web storage. */
function createKeychainSecrets(plugin: ManagedVaultPlugin): NonNullable<HostServices["secrets"]["app"]> | undefined {
  const { appSecretGet, appSecretSet, appSecretRemove } = plugin;
  if (!appSecretGet || !appSecretSet || !appSecretRemove) return undefined;
  return {
    get: async (key) => { const result = await appSecretGet.call(plugin, { key }); return result.found && typeof result.value === "string" ? result.value : null; },
    set: async (key, value) => { await appSecretSet.call(plugin, { key, value }); },
    remove: async (key) => { await appSecretRemove.call(plugin, { key }); },
  };
}

export function createCapacitorHost(plugin: ManagedVaultPlugin, portable: HostServices): HostServices {
  let opened = false;
  let activeRoot: string | null = null;
  const requireOpen = () => {
    if (!opened) throw new Error("No managed vault is open");
  };
  const formFactor = typeof window !== "undefined" && window.matchMedia?.("(min-width: 701px)").matches
    ? "tablet" as const
    : "phone" as const;

  const syncSafety = createCapacitorSyncSafety(plugin, portable, () => activeRoot);
  const appSecrets = createKeychainSecrets(plugin);

  return {
    ...portable,
    ...(syncSafety ? { syncSafety } : {}),
    ...(appSecrets ? { secrets: { ...portable.secrets, appAvailable: true, app: appSecrets } } : {}),
    capabilities: Object.freeze({ ...portable.capabilities, externalVaultFolder: true }),
    runtime: {
      runtime: "ios",
      platform: "ios",
      formFactor,
      getWindowChromeState: async () => ({ platform: "ios", isFullScreen: true, macChrome: "none" }),
      onWindowChromeState: () => () => {},
      onDeepLink: portable.runtime.onDeepLink,
      onForeground: portable.runtime.onForeground,
    },
    vaultRegistry: {
      chooseVault: async () => "managed://default",
      chooseExternalVault: async () => (await plugin.chooseExternalVault()).id,
      exploreSampleVault: async () => null,
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
          activeRoot = result.id;
          return { root: result.id, name: result.name };
        } catch (error) {
          vaultAccessError(error, path);
        }
      },
      getRecentVaults: async () => (await plugin.getRecentVaults()).ids,
      getLaunchVault: async () => (await plugin.getLaunchVault()).id,
      closeVault: async () => {
        opened = false;
        activeRoot = null;
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
        try { return decodeBase64((await plugin.readBinary({ path: managedVaultPath(path) })).base64); }
        catch (error) {
          // Not errors in the file: sync demotes just this path to "blocked" instead of failing the whole run.
          const code = (error as { code?: string }).code;
          if (code === "CONTENT_UNAVAILABLE") throw new SyncBlockedError("icloud-not-downloaded", "The provider has not downloaded this file to the device");
          if (code === "PAYLOAD_TOO_LARGE") throw new SyncBlockedError("too-large-for-mobile", "This file is larger than the 32 MiB the iOS bridge can carry");
          throw error;
        }
      },
      writeBinary: async (path, data, _writeOptions, mutationId) => {
        requireOpen();
        if (!plugin.writeBinary) throw new Error("Binary writes are unavailable in this iOS host version");
        const bytes = new Uint8Array(data); let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return plugin.writeBinary({ path: managedVaultPath(path), base64: btoa(binary), mutationId });
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
          const { entries, blocked } = splitICloudPlaceholders((await plugin.list()).entries);
          return { status: "complete", entries, ...(blocked.length ? { blocked } : {}) };
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
      readThemeCss: async (id) => {
        assertValidThemeId(id);
        return (await plugin.read({ path: `.geode/themes/${id}/theme.css` })).data;
      },
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
