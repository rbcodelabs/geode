import type { HostServices, VaultEvent, VaultFileEntry } from "./contracts";

export interface BrowserHostState {
  readonly vaultName: string;
  readonly files: Map<string, { data: string; ctime: number; mtime: number }>;
  readonly folders: Map<string, { ctime: number; mtime: number }>;
  readonly config: Map<string, unknown>;
  metadataCache: unknown | null;
  clock: number;
  persist(): void;
}

export interface BrowserHostStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SerializedBrowserHostState {
  vaultName: string;
  files: Array<[string, { data: string; ctime: number; mtime: number }]>;
  folders: Array<[string, { ctime: number; mtime: number }]>;
  config: Array<[string, unknown]>;
  metadataCache: unknown | null;
  clock: number;
}

export const BROWSER_HOST_STORAGE_KEY = "geode:mobile-managed-vault:v1";
const BROWSER_HOST_LAUNCH_VAULT_KEY = "geode:mobile-launch-vault:v1";

export function createBrowserHostState(options: {
  vaultName?: string;
  files?: Record<string, string>;
  storage?: BrowserHostStorage;
} = {}): BrowserHostState {
  const stored = options.storage?.getItem(BROWSER_HOST_STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as SerializedBrowserHostState;
      const state: BrowserHostState = {
        vaultName: parsed.vaultName,
        files: new Map(parsed.files.map(([path, file]) => [normalizeVaultPath(path), file])),
        folders: new Map(parsed.folders.map(([path, stat]) => [normalizeVaultPath(path), stat])),
        config: new Map(parsed.config),
        metadataCache: parsed.metadataCache,
        clock: parsed.clock,
        persist: () => persistBrowserHostState(state, options.storage),
      };
      return state;
    } catch {
      // Corrupt derived development storage falls back to the seeded vault.
    }
  }
  let clock = 1;
  const files = new Map<string, { data: string; ctime: number; mtime: number }>();
  for (const [path, data] of Object.entries(options.files ?? { "Welcome.md": "# Welcome to Geode Mobile\n" })) {
    files.set(normalizeVaultPath(path), { data, ctime: clock, mtime: clock++ });
  }
  const state: BrowserHostState = {
    vaultName: options.vaultName ?? "Geode Mobile",
    files,
    folders: new Map(),
    config: new Map(),
    metadataCache: null,
    clock,
    persist: () => persistBrowserHostState(state, options.storage),
  };
  state.persist();
  return state;
}

function persistBrowserHostState(state: BrowserHostState, storage?: BrowserHostStorage): void {
  if (!storage) return;
  // Slice-0 browser proof only: the in-memory mutation precedes this snapshot
  // write. A quota/serialization failure rejects the operation and leaves the
  // last durable snapshot intact, but the current page must be reloaded before
  // retrying. Production native storage will use coordinated atomic replace.
  const serialized: SerializedBrowserHostState = {
    vaultName: state.vaultName,
    files: [...state.files],
    folders: [...state.folders],
    config: [...state.config].map(([key, value]) => [key, structuredClone(value)]),
    metadataCache: structuredClone(state.metadataCache),
    clock: state.clock,
  };
  storage.setItem(BROWSER_HOST_STORAGE_KEY, JSON.stringify(serialized));
}

function normalizeVaultPath(path: string): string {
  if (path.includes("\0") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    throw new Error(`Expected a vault-relative path: ${path}`);
  }
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "." || part === ".." || part === "")) {
    throw new Error(`Expected a vault-relative path: ${path}`);
  }
  return normalized;
}

export function createBrowserHost(
  state = createBrowserHostState(),
  options: {
    openExternal?: (url: string) => void;
    externalVault?: { id: string; state: BrowserHostState };
    additionalVaults?: Array<{ id: string; state: BrowserHostState }>;
    registryStorage?: BrowserHostStorage;
    beforeWrite?: (vaultId: string, path: string, data: string) => Promise<void>;
    checkVault?: (id: string) => Promise<void>;
    reconnectVault?: (id: string) => Promise<boolean>;
    onListenerCountChange?: (count: number) => void;
    reconcileScan?: (vaultId: string, entries: VaultFileEntry[]) => Promise<{
      status: "complete" | "partial" | "cancelled" | "unavailable";
      entries: VaultFileEntry[];
      errorCode?: string;
    }>;
    onPluginFileRead?: (path: string) => void;
    beforePluginReplace?: (id: string) => Promise<void>;
  } = {},
): HostServices {
  const listeners = new Set<(event: VaultEvent) => void>();
  let activeState = state;
  let activeVaultId = "managed://default";
  let opened = false;
  const requireOpen = () => {
    if (!opened) throw new Error("No managed vault is open");
  };
  const emit = (event: VaultEvent) => listeners.forEach((listener) => listener(event));
  const now = () => ++activeState.clock;
  const external = options.externalVault;
  const externalVaults = new Map(
    [external, ...(options.additionalVaults ?? [])]
      .filter((vault): vault is { id: string; state: BrowserHostState } => vault !== undefined)
      .map((vault) => [vault.id, vault.state]),
  );
  const setLaunchVault = (id: string) => options.registryStorage?.setItem(BROWSER_HOST_LAUNCH_VAULT_KEY, id);
  const listActive = (): VaultFileEntry[] => {
    const entries: VaultFileEntry[] = [];
    for (const [path, stat] of activeState.folders) entries.push({ path, isFolder: true, ...stat, size: 0 });
    for (const [path, file] of activeState.files) {
      entries.push({ path, isFolder: false, mtime: file.mtime, ctime: file.ctime, size: new TextEncoder().encode(file.data).byteLength });
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  };

  return {
    capabilities: Object.freeze({
      multipleWindows: false,
      nodePlugins: false,
      embeddedWebContent: false,
      externalVaultFolder: externalVaults.size > 0,
      backgroundIndexer: false,
      shareSheet: false,
      threadExecution: false,
      processDiagnostics: false,
      chromeCookieImport: false,
      artifacts: false,
    }),
    runtime: {
      runtime: "browser",
      platform: "browser",
      formFactor: "phone",
      getWindowChromeState: async () => ({ platform: "darwin", isFullScreen: false }),
      onWindowChromeState: () => () => {},
      onDeepLink: () => () => {},
      onForeground: (callback) => {
        const handler = () => {
          if (document.visibilityState === "visible") callback();
        };
        document.addEventListener("visibilitychange", handler);
        return () => document.removeEventListener("visibilitychange", handler);
      },
    },
    vaultRegistry: {
      chooseVault: async () => "managed://default",
      chooseExternalVault: async () => external?.id ?? null,
      reconnectVault: async (id) => options.reconnectVault?.(id) ?? false,
      describeVault: async (id) => externalVaults.has(id)
        ? { id, name: externalVaults.get(id)!.vaultName, kind: "external" }
        : { id, name: state.vaultName, kind: "managed" },
      checkVault: async (id) => {
        await options.checkVault?.(id);
        if (id !== "managed://default" && !externalVaults.has(id)) throw new Error(`Unknown managed vault: ${id}`);
      },
      openVault: async (path) => {
        if (path === "managed://default") activeState = state;
        else if (externalVaults.has(path)) activeState = externalVaults.get(path)!;
        else throw new Error(`Unknown managed vault: ${path}`);
        activeVaultId = path;
        opened = true;
        setLaunchVault(path);
        return { root: path, name: activeState.vaultName };
      },
      getRecentVaults: async () => ["managed://default", ...externalVaults.keys()],
      getLaunchVault: async () => options.registryStorage?.getItem(BROWSER_HOST_LAUNCH_VAULT_KEY) ?? "managed://default",
      closeVault: async () => { opened = false; },
    },
    vaultFiles: {
      list: async () => {
        requireOpen();
        return listActive();
      },
      read: async (path) => {
        requireOpen();
        const file = activeState.files.get(normalizeVaultPath(path));
        if (!file) throw new Error(`File not found: ${path}`);
        return file.data;
      },
      readBinary: async (path) => {
        const data = await createBrowserHostReader(activeState, requireOpen, path);
        return new TextEncoder().encode(data).buffer;
      },
      write: async (path, data, writeOptions, mutationId) => {
        requireOpen();
        const key = normalizeVaultPath(path);
        await options.beforeWrite?.(activeVaultId, key, data);
        requireOpen();
        const prior = activeState.files.get(key);
        const timestamp = now();
        // ctime is intentionally never taken from writeOptions — this in-memory
        // host mirrors the real fs write path's documented limitation that a
        // file's birthtime can't be set independently of its mtime.
        const file = { data, ctime: prior?.ctime ?? timestamp, mtime: writeOptions?.mtime ?? timestamp };
        activeState.files.set(key, file);
        activeState.persist();
        emit({ event: prior ? "modify" : "create", path: key, mutationId });
        return { mtime: file.mtime, ctime: file.ctime, size: new TextEncoder().encode(data).byteLength };
      },
      mkdir: async (path, mutationId) => {
        requireOpen();
        const key = normalizeVaultPath(path);
        const timestamp = now();
        activeState.folders.set(key, { ctime: timestamp, mtime: timestamp });
        activeState.persist();
        emit({ event: "create-folder", path: key, mutationId });
      },
      trash: async (path, mutationId) => {
        requireOpen();
        const key = normalizeVaultPath(path);
        if (activeState.files.delete(key)) {
          activeState.persist();
          emit({ event: "delete", path: key, mutationId });
          return;
        }
        if (!activeState.folders.has(key)) return;
        const prefix = `${key}/`;
        const descendantFiles = [...activeState.files.keys()].filter((candidate) => candidate.startsWith(prefix)).sort().reverse();
        const descendantFolders = [...activeState.folders.keys()].filter((candidate) => candidate.startsWith(prefix)).sort().reverse();
        for (const candidate of descendantFiles) activeState.files.delete(candidate);
        for (const candidate of descendantFolders) activeState.folders.delete(candidate);
        activeState.folders.delete(key);
        activeState.persist();
        for (const candidate of descendantFiles) emit({ event: "delete", path: candidate, mutationId });
        for (const candidate of descendantFolders) emit({ event: "delete-folder", path: candidate, mutationId });
        emit({ event: "delete-folder", path: key, mutationId });
      },
      rename: async (path, newPath, mutationId) => {
        requireOpen();
        const from = normalizeVaultPath(path);
        const to = normalizeVaultPath(newPath);
        if (from === to) return;
        const file = activeState.files.get(from);
        if (file) {
          if (activeState.files.has(to) || activeState.folders.has(to)) {
            throw new Error(`Rename destination already exists: ${to}`);
          }
          activeState.files.delete(from);
          activeState.files.set(to, { ...file, mtime: now() });
          activeState.persist();
          emit({ event: "delete", path: from, mutationId });
          emit({ event: "create", path: to, mutationId });
          return;
        }
        if (!activeState.folders.has(from)) throw new Error(`File or folder not found: ${path}`);
        if (to.startsWith(`${from}/`)) throw new Error(`Rename destination is inside the source: ${to}`);
        const prefix = `${from}/`;
        const folderMoves = [...activeState.folders.entries()]
          .filter(([candidate]) => candidate === from || candidate.startsWith(prefix))
          .map(([candidate, stat]) => [candidate, `${to}${candidate.slice(from.length)}`, stat] as const);
        const fileMoves = [...activeState.files.entries()]
          .filter(([candidate]) => candidate.startsWith(prefix))
          .map(([candidate, value]) => [candidate, `${to}${candidate.slice(from.length)}`, value] as const);
        const movingPaths = new Set([
          ...folderMoves.map(([oldPath]) => oldPath),
          ...fileMoves.map(([oldPath]) => oldPath),
        ]);
        const destinations = [
          ...folderMoves.map(([, newPath]) => newPath),
          ...fileMoves.map(([, newPath]) => newPath),
        ];
        for (const destination of destinations) {
          if ((!movingPaths.has(destination) && activeState.files.has(destination)) ||
              (!movingPaths.has(destination) && activeState.folders.has(destination))) {
            throw new Error(`Rename destination already exists: ${destination}`);
          }
          let parent = destination.includes("/") ? destination.slice(0, destination.lastIndexOf("/")) : "";
          while (parent) {
            if (!movingPaths.has(parent) && activeState.files.has(parent)) {
              throw new Error(`Rename destination already exists: ${parent}`);
            }
            parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
          }
        }
        for (const [oldPath] of fileMoves) activeState.files.delete(oldPath);
        for (const [oldPath] of folderMoves) activeState.folders.delete(oldPath);
        for (const [, newPath, stat] of folderMoves) activeState.folders.set(newPath, { ...stat, mtime: now() });
        for (const [, newPath, value] of fileMoves) activeState.files.set(newPath, { ...value, mtime: now() });
        activeState.persist();
        for (const [oldPath] of fileMoves) emit({ event: "delete", path: oldPath, mutationId });
        for (const [oldPath] of [...folderMoves].reverse()) emit({ event: "delete-folder", path: oldPath, mutationId });
        for (const [, newPath] of folderMoves) emit({ event: "create-folder", path: newPath, mutationId });
        for (const [, newPath] of fileMoves) emit({ event: "create", path: newPath, mutationId });
      },
      // Browser mutations emit synchronously before their operation resolves.
      settleMutation: async () => {},
      exists: async (path) => {
        requireOpen();
        const key = normalizeVaultPath(path);
        return activeState.files.has(key) || activeState.folders.has(key);
      },
      onChange: (cb) => {
        listeners.add(cb);
        options.onListenerCountChange?.(listeners.size);
        return () => {
          listeners.delete(cb);
          options.onListenerCountChange?.(listeners.size);
        };
      },
      reconcileScan: async () => {
        requireOpen();
        const entries = listActive();
        return options.reconcileScan?.(activeVaultId, entries) ?? { status: "complete", entries };
      },
    },
    config: {
      read: async (name) => structuredClone(activeState.config.get(name) ?? null),
      write: async (name, data) => { activeState.config.set(name, structuredClone(data)); activeState.persist(); },
    },
    metadataIndex: {
      readCache: async () => structuredClone(activeState.metadataCache),
      writeCache: async (data) => { activeState.metadataCache = structuredClone(data); activeState.persist(); },
      startBackgroundIndexer: async () => null,
      onMessage: () => () => {},
    },
    navigation: {
      openExternal: async (url) => {
        const parsed = new URL(url);
        if (!["https:", "http:", "mailto:", "tel:"].includes(parsed.protocol)) {
          throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
        }
        (options.openExternal ?? ((safeUrl) => { globalThis.open?.(safeUrl, "_blank", "noopener"); }))(parsed.href);
      },
      openLocalFile: async () => ({ kind: "rejected" }),
    },
    plugins: {
      listPluginIds: async () => {
        requireOpen();
        const ids = new Set<string>();
        for (const path of activeState.files.keys()) {
          const match = /^\.geode\/plugins\/([a-z0-9][a-z0-9-]*)\/manifest\.json$/.exec(path);
          if (match) ids.add(match[1]);
        }
        return [...ids].sort();
      },
      listThemes: async () => [],
      readPluginFile: async (path, rendererSentAt) => {
        requireOpen();
        options.onPluginFileRead?.(path);
        const now = Date.now();
        let key: string;
        try { key = normalizeVaultPath(path); } catch { return { ok: false, errorCode: "INVALID_PLUGIN_PATH", mainReceivedAt: now, fsStartedAt: now, fsFinishedAt: now }; }
        if (!/^\.geode\/plugins\/[a-z0-9][a-z0-9-]*\/(manifest\.json|main\.js|styles\.css)$/.test(key)) {
          return { ok: false, errorCode: "INVALID_PLUGIN_PATH", mainReceivedAt: now, fsStartedAt: now, fsFinishedAt: now };
        }
        const content = activeState.files.get(key)?.data;
        return content === undefined
          ? { ok: false, errorCode: "PLUGIN_FILE_NOT_FOUND", mainReceivedAt: rendererSentAt, fsStartedAt: now, fsFinishedAt: Date.now() }
          : { ok: true, content, mainReceivedAt: rendererSentAt, fsStartedAt: now, fsFinishedAt: Date.now() };
      },
      replacePluginFiles: async (id, expectedManifest, replacement) => {
        requireOpen();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("INVALID_PLUGIN_ID");
        await options.beforePluginReplace?.(id);
        const base = `.geode/plugins/${id}`;
        const current = {
          manifest: activeState.files.get(`${base}/manifest.json`)?.data,
          main: activeState.files.get(`${base}/main.js`)?.data,
          styles: activeState.files.get(`${base}/styles.css`)?.data ?? null,
        };
        if (current.manifest !== expectedManifest) {
          throw new Error("PLUGIN_FILES_CHANGED");
        }
        const snapshot = new Map(activeState.files);
        try {
          const stamp = now();
          activeState.files.set(`${base}/manifest.json`, { data: replacement.manifest, ctime: stamp, mtime: stamp });
          activeState.files.set(`${base}/main.js`, { data: replacement.main, ctime: stamp, mtime: stamp });
          if (replacement.styles === null) activeState.files.delete(`${base}/styles.css`);
          else activeState.files.set(`${base}/styles.css`, { data: replacement.styles, ctime: stamp, mtime: stamp });
          activeState.persist();
        } catch (error) {
          activeState.files.clear();
          for (const [path, file] of snapshot) activeState.files.set(path, file);
          throw error;
        }
      },
      getPolicy: async () => null,
      getCrashRecoveryState: async () => ({ suppressPlugins: false, entries: [] }),
      leaveCrashRecovery: async () => {},
      reportCrashDiagnostic: async () => {},
      reportActivePlugins: async () => {},
    },
  };
}

async function createBrowserHostReader(
  state: BrowserHostState,
  requireOpen: () => void,
  path: string,
): Promise<string> {
  requireOpen();
  const file = state.files.get(normalizeVaultPath(path));
  if (!file) throw new Error(`File not found: ${path}`);
  return file.data;
}
