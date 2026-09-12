import { contextBridge, ipcRenderer } from "electron";
import type { CommunityPreview, InstalledResult, ResolveOpts } from "./github-resolve";
import type { ObsidianImportResult } from "./obsidian-import";
import type { ManagedPolicy } from "../renderer/policy";
import type { ChromeProfile, ChromeCookieImportResult } from "./chrome-cookies";
import type { ProcessMetric } from "./process-metrics";
import type { CrashDiagnostic } from "./crash-journal";
import type { FdPressureSnapshot } from "./crash-diagnostics";
import type { ArtifactRegistrationResult } from "./artifact-runtime";
import type { ExternalRootsHost, ExternalRootReply } from "../shared/external-roots";
import type { ResourceRef } from "../shared/root-registry";
import type { PrivilegedRequestUrlParam, PrivilegedRequestUrlResponse } from "../shared/request-url";
import type { PrivilegedFetchRequest, PrivilegedFetchResponse } from "../shared/plugin-fetch";
import type { SupportedPluginCatalogIpcState } from "./supported-plugin-catalog";
import type { SecretSnapshot } from "./secret-store";
import type { NormalizedWebViewerEvent } from "../shared/web-viewer-connectors";

async function invokeExternalRoot<T>(channel: string, ...args: unknown[]): Promise<T> {
  const reply: ExternalRootReply<T> = await ipcRenderer.invoke(channel, ...args);
  if (reply.ok) return reply.value;
  throw Object.assign(new Error(`External root: ${reply.error}`), { code: reply.error });
}

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

export interface TimedPluginReadResult {
  ok: boolean;
  content?: string;
  errorCode?: string;
  mainReceivedAt: number;
  fsStartedAt: number;
  fsFinishedAt: number;
}
export interface PluginFileSet { manifest: string; main: string; styles: string | null }

export interface GuestWindowOpenRequest {
  url: string;
  guestId: number;
  disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
}

export interface UpdaterCheckResult {
  status: "checking" | "disabled";
}

const api = {
  externalRoots: (process.platform === "darwin" ? Object.freeze({
    version: 1,
    contribute: (projects, options) => invokeExternalRoot("external-roots-contribute", projects, options),
    listProjects: () => invokeExternalRoot("external-roots-projects"),
    attach: (projectId) => invokeExternalRoot("external-roots-attach", projectId),
    reconnect: (projectId) => invokeExternalRoot("external-roots-reconnect", projectId),
    detach: (projectId) => invokeExternalRoot("external-roots-detach", projectId),
    listDirectory: (ref, options) => invokeExternalRoot("external-roots-list", ref, options),
    readText: (ref) => invokeExternalRoot("external-roots-read", ref),
    listGrants: () => invokeExternalRoot("external-roots-grants"),
    removeStaleAssociation: (projectId) => invokeExternalRoot("external-roots-remove-association", projectId),
    removeOrphanGrant: (rootId) => invokeExternalRoot("external-roots-remove-orphan", rootId),
    onChange: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("external-roots-changed", listener);
      return () => ipcRenderer.removeListener("external-roots-changed", listener);
    },
  } satisfies ExternalRootsHost) : undefined),
  host: Object.freeze({ name: "geode" as const, protocolScheme: "geode" as const }),
  requestUrl: (request: PrivilegedRequestUrlParam): Promise<PrivilegedRequestUrlResponse> =>
    ipcRenderer.invoke("request-url", request),
  /**
   * Privileged sibling of `requestUrl` for plugins' raw `fetch()` calls —
   * see `pluginFetch` in `src/renderer/plugin-fetch.ts`, which is what
   * actually calls this. Same CSP-bypass IPC pattern, but carries
   * pre-serialized body bytes for any `fetch()` body shape (including
   * `FormData`) rather than `requestUrl`'s `string | ArrayBuffer`.
   */
  pluginFetch: (request: PrivilegedFetchRequest): Promise<PrivilegedFetchResponse> =>
    ipcRenderer.invoke("plugin-fetch", request),
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
  readPluginFile: (path: string, rendererSentAt: number): Promise<TimedPluginReadResult> =>
    ipcRenderer.invoke("plugin-file-read", path, rendererSentAt),
  replacePluginFiles: (id: string, expectedManifest: string, replacement: PluginFileSet): Promise<void> =>
    ipcRenderer.invoke("plugin-files-replace", id, expectedManifest, replacement),
  readBinary: (path: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke("vault-read-binary", path),
  write: (
    path: string,
    data: string,
    options?: { mtime?: number; ctime?: number },
  ): Promise<{ mtime: number; ctime: number; size: number }> =>
    ipcRenderer.invoke("vault-write", path, data, options),
  mkdir: (path: string): Promise<void> => ipcRenderer.invoke("vault-mkdir", path),
  trash: (path: string): Promise<void> => ipcRenderer.invoke("vault-delete", path),
  /** Obsidian's `adapter.rmdir`: remove a vault folder outright, no trash. */
  rmdir: (path: string, recursive: boolean): Promise<void> =>
    ipcRenderer.invoke("vault-rmdir", path, recursive),
  rename: (path: string, newPath: string): Promise<void> =>
    ipcRenderer.invoke("vault-rename", path, newPath),
  exists: (path: string): Promise<boolean> => ipcRenderer.invoke("vault-exists", path),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke("vault-reveal", path),
  readMetadataCache: (): Promise<unknown | null> => ipcRenderer.invoke("metadata-cache-read"),
  beginMetadataCacheRead: (): Promise<{ token: string; schemaVersion: number }> => ipcRenderer.invoke("metadata-cache-begin"),
  readMetadataCachePage: (token: string, sequence: number): Promise<import("./metadata-cache-reader").MetadataCachePage> => ipcRenderer.invoke("metadata-cache-page", token, sequence),
  cancelMetadataCacheRead: (token: string): Promise<void> => ipcRenderer.invoke("metadata-cache-cancel", token),
  writeMetadataCache: (data: unknown): Promise<void> => ipcRenderer.invoke("metadata-cache-write", data),
  /**
   * Upsert one bounded batch of entries (a partial snapshot, not the whole
   * vault). Used by the renderer's chunked persist path so no single IPC
   * call ever needs to structured-clone a full-vault-sized payload — see
   * `metadata-cache-store.ts`'s `pruneMetadataEntries` doc comment.
   */
  upsertMetadataCacheEntries: (data: unknown): Promise<void> =>
    ipcRenderer.invoke("metadata-cache-upsert", data),
  /** Delete any persisted row whose path is not in `paths` — call once, after all upsert batches have landed. */
  pruneMetadataCache: (paths: string[]): Promise<void> => ipcRenderer.invoke("metadata-cache-prune", paths),
  startMetadataIndexer: (): Promise<true | null> => ipcRenderer.invoke("metadata-indexer-start"),
  /** Fire-and-forget diagnostic: the renderer had to fall back to indexing the vault itself because the background utility process was unavailable. */
  reportMetadataFallback: (info: { reason: string; fileCount: number }): Promise<void> =>
    ipcRenderer.invoke("metadata-fallback-entered", info),
  onMetadataIndexerMessage: (cb: (message: any) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, message: any) => cb(message);
    ipcRenderer.on("metadata-indexer-message", listener);
    return () => { ipcRenderer.removeListener("metadata-indexer-message", listener); };
  },
  /**
   * Read the whole keychain-backed secret store in one blocking call, handing
   * main any plaintext entries being migrated out of the renderer's old
   * localStorage store. This is the only synchronous call on the bridge, and
   * it exists because Obsidian's `app.secretStorage` API is itself synchronous
   * — see the `secrets-read-all` handler in main.ts. It is made at most once
   * per renderer, lazily, and only if something actually reads a secret.
   */
  readSecretsSync: (migrating: Record<string, string>): SecretSnapshot =>
    ipcRenderer.sendSync("secrets-read-all", migrating),
  getSecret: (id: string): Promise<string | null> => ipcRenderer.invoke("secrets-get", id),
  listSecrets: (): Promise<string[]> => ipcRenderer.invoke("secrets-list"),
  setSecret: (id: string, value: string): Promise<void> =>
    ipcRenderer.invoke("secrets-set", id, value),
  deleteSecret: (id: string): Promise<void> => ipcRenderer.invoke("secrets-delete", id),
  isSecretEncryptionAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke("secrets-encryption-available"),
  readConfig: (name: string): Promise<unknown> => ipcRenderer.invoke("config-read", name),
  writeConfig: (name: string, data: unknown): Promise<void> =>
    ipcRenderer.invoke("config-write", name, data),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("open-external", url),
  openLocalFile: (href: string): Promise<
    | { kind: "vault"; path: string; line?: number; column?: number }
    | { kind: "external-resource"; ref: ResourceRef; rootLabel: string }
    | { kind: "external" }
    | { kind: "rejected" }
  > => ipcRenderer.invoke("open-local-file", href),
  listPluginIds: (): Promise<string[]> => ipcRenderer.invoke("plugins-list-ids"),
  listThemes: (): Promise<string[]> => ipcRenderer.invoke("themes-list"),
  getSupportedPluginCatalog: (): Promise<SupportedPluginCatalogIpcState> =>
    ipcRenderer.invoke("supported-plugin-catalog"),
  installSupportedPlugin: (
    pluginId: string,
    release: "tested" | "latest",
  ): Promise<InstalledResult> => ipcRenderer.invoke("supported-plugin-install", pluginId, release),
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
  getFdPressure: (): Promise<FdPressureSnapshot> => ipcRenderer.invoke("get-fd-pressure"),
  getCrashRecoveryState: (): Promise<{ suppressPlugins: boolean; entries: CrashDiagnostic[] }> =>
    ipcRenderer.invoke("crash-recovery-state"),
  reportCrashDiagnostic: (entry: CrashDiagnostic): Promise<void> =>
    ipcRenderer.invoke("crash-diagnostic", entry),
  reportActivePlugins: (pluginIds: string[]): Promise<void> =>
    ipcRenderer.invoke("crash-active-plugins", pluginIds),
  leaveCrashRecovery: (): Promise<void> => ipcRenderer.invoke("crash-recovery-leave"),
  registerArtifact: (root: string): Promise<ArtifactRegistrationResult> =>
    ipcRenderer.invoke("artifact-register", root),
  unregisterArtifact: (registrationId: string): Promise<boolean> =>
    ipcRenderer.invoke("artifact-unregister", registrationId),
  getArtifactState: (registrationId: string) => ipcRenderer.invoke("artifact-state", registrationId),
  captureArtifact: (root: string) => ipcRenderer.invoke("artifact-capture", root),
  onVaultEvent: (cb: (ev: VaultEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: VaultEvent) => cb(ev);
    ipcRenderer.on("vault-event", listener);
    return () => { ipcRenderer.removeListener("vault-event", listener); };
  },
  onDeepLink: (cb: (link: { action: string; params: Record<string, string> }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, link: { action: string; params: Record<string, string> }) => cb(link);
    ipcRenderer.on("geode-deep-link", listener);
    return () => { ipcRenderer.removeListener("geode-deep-link", listener); };
  },
  getWindowChromeState: (): Promise<{ platform: NodeJS.Platform; isFullScreen: boolean }> =>
    ipcRenderer.invoke("window-chrome-state"),
  setWindowBackgroundColor: (color: string): Promise<void> =>
    ipcRenderer.invoke("window-background-color", color),
  onWindowChromeState: (
    cb: (state: { platform: NodeJS.Platform; isFullScreen: boolean }) => void,
  ) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      state: { platform: NodeJS.Platform; isFullScreen: boolean },
    ) => cb(state);
    ipcRenderer.on("window-chrome-state", listener);
    return () => { ipcRenderer.removeListener("window-chrome-state", listener); };
  },
  /**
   * Tell main which combos the CommandRegistry currently has bound. Main's
   * `before-input-event` handler for `<webview>` guests is synchronous and
   * cannot ask the renderer mid-keystroke, so it matches against this list.
   */
  publishHotkeys: (combos: string[]): Promise<void> =>
    ipcRenderer.invoke("hotkeys-publish", combos),
  /** A hotkey pressed inside a `<webview>` guest, forwarded back to the host. */
  /**
   * `guestId` is the WebContents id of the guest the keystroke came from. The
   * host's active leaf does not follow focus into a `<webview>` (a click
   * inside a guest never produces a host DOM mouse event), so without it a
   * hotkey pressed in one guest would act on whichever pane the host last
   * considered active.
   */
  onGuestHotkey: (cb: (combo: string, guestId: number) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, combo: string, guestId: number) => cb(combo, guestId);
    ipcRenderer.on("guest-hotkey", listener);
    return () => { ipcRenderer.removeListener("guest-hotkey", listener); };
  },
  /** A web URL that a `<webview>` guest requested in a new browsing context. */
  onGuestWindowOpen: (cb: (request: GuestWindowOpenRequest) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, request: GuestWindowOpenRequest) => cb(request);
    ipcRenderer.on("guest-window-open", listener);
    return () => { ipcRenderer.removeListener("guest-window-open", listener); };
  },
  /**
   * A normalized, origin-checked event posted from inside a Web Viewer guest
   * via `window.__geode.postEvent` (see webviewer-bridge-preload.ts and
   * main.ts's `trackWebViewerBridgeGuest`).
   */
  onWebViewerBridgeEvent: (cb: (ev: NormalizedWebViewerEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: NormalizedWebViewerEvent) => cb(ev);
    ipcRenderer.on("web-viewer-bridge-event", listener);
    return () => { ipcRenderer.removeListener("web-viewer-bridge-event", listener); };
  },
  checkForUpdates: (): Promise<UpdaterCheckResult> => ipcRenderer.invoke("updater-check"),
};

// A main-process watchdog can distinguish a wedged renderer from a merely
// crashed one. backgroundThrottling is disabled for this window in main.ts.
const heartbeatIntervalMs = Number(process.env.GEODE_TEST_HEARTBEAT_INTERVAL_MS ?? 5_000);
const heartbeat = setInterval(() => ipcRenderer.send("renderer-heartbeat"), heartbeatIntervalMs);
heartbeat.unref?.();
ipcRenderer.send("renderer-heartbeat");

type ElectronOnlyGeodeApi = typeof api;

/**
 * `upsertMetadataCacheEntries`/`pruneMetadataCache`/`reportMetadataFallback`
 * are declared optional here (though the real Electron `api` object above
 * always implements them) so that other `GeodeApi`-shaped hosts —
 * `createLegacyGeodeFacade` wraps `HostServices` for mobile/browser, whose
 * `MetadataIndexService` never grew a chunked-write or diagnostic-report
 * capability — aren't forced to fake an implementation just to satisfy this
 * type. `MetadataCache.persistCache()` checks for their presence and falls
 * back to the original single-shot `writeMetadataCache` call when they're
 * absent, which is exactly what those hosts already did before chunked
 * persistence existed — see its doc comment.
 */
export type GeodeApi = Omit<
  ElectronOnlyGeodeApi,
  "upsertMetadataCacheEntries" | "pruneMetadataCache" | "reportMetadataFallback" | "externalRoots" |
  "requestUrl" | "pluginFetch" | "getSupportedPluginCatalog" | "installSupportedPlugin" |
  "readSecretsSync" | "getSecret" | "listSecrets" | "setSecret" | "deleteSecret" |
  "isSecretEncryptionAvailable" | "beginMetadataCacheRead" | "readMetadataCachePage" | "cancelMetadataCacheRead"
> & {
  beginMetadataCacheRead?: ElectronOnlyGeodeApi["beginMetadataCacheRead"];
  readMetadataCachePage?: ElectronOnlyGeodeApi["readMetadataCachePage"];
  cancelMetadataCacheRead?: ElectronOnlyGeodeApi["cancelMetadataCacheRead"];
  externalRoots?: ExternalRootsHost;
  upsertMetadataCacheEntries?: ElectronOnlyGeodeApi["upsertMetadataCacheEntries"];
  pruneMetadataCache?: ElectronOnlyGeodeApi["pruneMetadataCache"];
  reportMetadataFallback?: ElectronOnlyGeodeApi["reportMetadataFallback"];
  requestUrl?: ElectronOnlyGeodeApi["requestUrl"];
  /** Absent on the mobile/browser facade — see `pluginFetch` in `src/renderer/plugin-fetch.ts` for its native-`fetch` fallback when unset. */
  pluginFetch?: ElectronOnlyGeodeApi["pluginFetch"];
  getSupportedPluginCatalog?: ElectronOnlyGeodeApi["getSupportedPluginCatalog"];
  installSupportedPlugin?: ElectronOnlyGeodeApi["installSupportedPlugin"];
  /**
   * Secret storage is keychain-backed and Electron-only. Absent on the
   * mobile/browser facade, where `createSecretStorage` falls back to
   * localStorage and reports `isEncryptionAvailable() === false` rather than
   * claiming a keychain it does not have.
   */
  readSecretsSync?: ElectronOnlyGeodeApi["readSecretsSync"];
  getSecret?: ElectronOnlyGeodeApi["getSecret"];
  listSecrets?: ElectronOnlyGeodeApi["listSecrets"];
  setSecret?: ElectronOnlyGeodeApi["setSecret"];
  deleteSecret?: ElectronOnlyGeodeApi["deleteSecret"];
  isSecretEncryptionAvailable?: ElectronOnlyGeodeApi["isSecretEncryptionAvailable"];
};

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
