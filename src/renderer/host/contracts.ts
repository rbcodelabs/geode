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
  /** Correlates the immediate echo of an app-originated mutation. */
  mutationId?: string;
  /** Optional provider revision. Distinct revisions must not be collapsed. */
  version?: string;
}

export interface HostCapabilities {
  multipleWindows: boolean;
  nodePlugins: boolean;
  embeddedWebContent: boolean;
  externalVaultFolder: boolean;
  backgroundIndexer: boolean;
  shareSheet: boolean;
  threadExecution: boolean;
  processDiagnostics: boolean;
  chromeCookieImport: boolean;
  artifacts: boolean;
}

export interface RuntimeService {
  readonly runtime: "electron" | "browser" | "ios" | "android";
  readonly platform: string;
  readonly formFactor: "desktop" | "phone" | "tablet";
  getWindowChromeState(): Promise<{ platform: string; isFullScreen: boolean }>;
  onWindowChromeState(cb: (state: { platform: string; isFullScreen: boolean }) => void): () => void;
  onDeepLink(cb: (link: { action: string; params: Record<string, string> }) => void): () => void;
  /** Fires after the app becomes foreground-active; desktop hosts may return an inert disposer. */
  onForeground(cb: () => void): () => void;
}

export interface VaultRegistryService {
  chooseVault(): Promise<string | null>;
  chooseExternalVault(): Promise<string | null>;
  reconnectVault(id: string): Promise<boolean>;
  describeVault(id: string): Promise<{ id: string; name: string; kind: "managed" | "external" }>;
  /** Verify that an exact vault can be activated without changing the active root. */
  checkVault(id: string): Promise<void>;
  openVault(path: string): Promise<{ root: string; name: string }>;
  getRecentVaults(): Promise<string[]>;
  getLaunchVault(): Promise<string | null>;
  closeVault(): Promise<void>;
}

export type VaultAccessState = "unavailable" | "permission-revoked" | "missing";

export class VaultAccessError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly vaultId: string,
    readonly vaultName: string,
    readonly state: VaultAccessState,
  ) {
    super(message);
    this.name = "VaultAccessError";
  }
}

export interface VaultFilesService {
  list(): Promise<VaultFileEntry[]>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, data: string, mutationId?: string): Promise<{ mtime: number; ctime: number; size: number }>;
  mkdir(path: string, mutationId?: string): Promise<void>;
  trash(path: string, mutationId?: string): Promise<void>;
  rename(path: string, newPath: string, mutationId?: string): Promise<void>;
  /** Resolves after every change event carrying this mutation id has been delivered. */
  settleMutation(mutationId: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  onChange(cb: (event: VaultEvent) => void): () => void;
  /** A bounded authoritative scan; non-complete results must not be diffed as deletion. */
  reconcileScan(): Promise<{
    status: "complete" | "partial" | "cancelled" | "unavailable";
    entries: VaultFileEntry[];
    errorCode?: string;
  }>;
}

export interface ConfigService {
  read(name: string): Promise<unknown>;
  write(name: string, data: unknown): Promise<void>;
}

export interface MetadataIndexService {
  readCache(): Promise<unknown | null>;
  writeCache(data: unknown): Promise<void>;
  startBackgroundIndexer(): Promise<true | null>;
  onMessage(cb: (message: unknown) => void): () => void;
}

export interface NavigationService {
  openExternal(url: string): Promise<void>;
  openLocalFile(href: string): Promise<
    | { kind: "vault"; path: string; line?: number; column?: number }
    | { kind: "external" }
    | { kind: "rejected" }
  >;
}

export interface PluginHostService {
  listPluginIds(): Promise<string[]>;
  listThemes(): Promise<string[]>;
  readPluginFile(path: string, rendererSentAt: number): Promise<{
    ok: boolean;
    content?: string;
    errorCode?: string;
    mainReceivedAt: number;
    fsStartedAt: number;
    fsFinishedAt: number;
  }>;
  replacePluginFiles(id: string, expectedManifest: string, replacement: PluginFileSet): Promise<void>;
  getPolicy(): Promise<unknown | null>;
  getCrashRecoveryState(): Promise<{ suppressPlugins: boolean; entries: unknown[] }>;
  leaveCrashRecovery(): Promise<void>;
  reportCrashDiagnostic(entry: unknown): Promise<void>;
  reportActivePlugins(pluginIds: string[]): Promise<void>;
}

export interface PluginFileSet {
  manifest: string;
  main: string;
  styles: string | null;
}

/** Desktop-only APIs are absent on mobile; callers gate on capabilities first. */
export interface DesktopHostService {
  openVaultWindow(path: string): Promise<{ action: "current" | "focused" | "created" }>;
  setWindowBackgroundColor(color: string): Promise<void>;
  publishHotkeys(combos: string[]): Promise<void>;
  onGuestHotkey(cb: (combo: string, guestId: number) => void): () => void;
}

export interface HostServices {
  readonly capabilities: Readonly<HostCapabilities>;
  readonly runtime: RuntimeService;
  readonly vaultRegistry: VaultRegistryService;
  readonly vaultFiles: VaultFilesService;
  readonly config: ConfigService;
  readonly metadataIndex: MetadataIndexService;
  readonly navigation: NavigationService;
  readonly plugins: PluginHostService;
  readonly desktop?: DesktopHostService;
}
