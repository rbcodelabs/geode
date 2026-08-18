import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, nativeImage, powerSaveBlocker, shell, utilityProcess } from "electron";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import chokidar, { FSWatcher } from "chokidar";
import { installCommunity, resolveCommunity } from "./community";
import type { ResolveOpts } from "./github-resolve";
import { validatePolicy, type ManagedPolicy } from "../renderer/policy";
import { withPathLock } from "./path-lock";
import { listChromeProfiles, importChromeCookies } from "./chrome-cookies";
import { getProcessMetricsSnapshot } from "./process-metrics";
import { PowerSaveBlockerRegistry } from "./power-save-blocker";
import { readMetadataCache, writeMetadataCache } from "./metadata-cache-store";
import { parseLocalFileHref } from "../renderer/external-links";
import { isAllowedAppNavigation } from "./navigation-policy";
import { MetadataIndexerHost } from "./metadata-indexer-host";
import type { MetadataFileStat } from "../indexer/metadata-indexer";
import { CrashJournal, type CrashDiagnostic } from "./crash-journal";
import {
  BoundedBuffer,
  DiagnosticLog,
  buildRendererIncident,
  exportDiagnostics,
  listCrashDumps,
  pruneCrashDumps,
  sanitizeDiagnosticValue,
  type CrashDumpFile,
  type DiagnosticEntry,
} from "./crash-diagnostics";
import { randomUUID } from "node:crypto";
import { buildApplicationMenuTemplate } from "./application-menu";

// Chromium gates SharedArrayBuffer behind cross-origin isolation by default.
// Obsidian enables it so plugins (and the libraries they bundle, e.g. the
// Claude Agent SDK) can use it; Geode does the same for plugin
// compatibility. Must be set before app 'ready'.
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
crashReporter.start({ uploadToServer: false, companyName: "RBCodelabs", productName: "Geode" });

interface VaultSession {
  root: string;
  watcher: FSWatcher | null;
  indexer: MetadataIndexerHost | null;
  indexerReady: Promise<unknown | null>;
}

const sessions = new Map<number, VaultSession>();
interface CrashState {
  suppressPlugins: boolean;
  activePlugins: string[];
  lastHeartbeat: number;
  recovering: boolean;
  breadcrumbs: BoundedBuffer<DiagnosticEntry>;
  consoleEntries: BoundedBuffer<DiagnosticEntry>;
  knownDumps: CrashDumpFile[];
  lastProcessMetrics: ReturnType<typeof getProcessMetricsSnapshot>;
}
const crashStates = new Map<number, CrashState>();
const powerSaveBlockers = new PowerSaveBlockerRegistry(powerSaveBlocker);
const powerSaveBlockerOwners = new Set<number>();
let journal: CrashJournal | undefined;
let diagnosticLog: DiagnosticLog | undefined;

function crashJournal(): CrashJournal {
  return (journal ??= new CrashJournal(path.join(app.getPath("userData"), "crash-journal.json")));
}

function diagnostics(): DiagnosticLog {
  return (diagnosticLog ??= new DiagnosticLog(path.join(app.getPath("userData"), "diagnostic.log")));
}

function recordDiagnostic(state: CrashState | undefined, entry: DiagnosticEntry, consoleEntry = false): void {
  const safe: DiagnosticEntry = {
    ...entry,
    message: sanitizeDiagnosticValue(entry.message),
    metadata: entry.metadata && Object.fromEntries(Object.entries(entry.metadata).map(([key, value]) => [
      key,
      typeof value === "string" ? sanitizeDiagnosticValue(value) : value,
    ])),
  };
  (consoleEntry ? state?.consoleEntries : state?.breadcrumbs)?.push(safe);
  void diagnostics().append(safe).catch(() => {});
}

function appConfigPath(): string {
  return path.join(app.getPath("userData"), "geode.json");
}

interface GlobalConfig {
  recentVaults: string[];
  lastVault?: string;
}

function loadConfig(): GlobalConfig {
  try {
    return JSON.parse(fs.readFileSync(appConfigPath(), "utf8"));
  } catch {
    return { recentVaults: [] };
  }
}

function saveConfig(cfg: GlobalConfig) {
  fs.writeFileSync(appConfigPath(), JSON.stringify(cfg, null, 2));
}

/**
 * Fixed, OS-specific, machine-level path for the enterprise-managed plugin
 * policy file — deliberately NOT the same directory as `appConfigPath()`
 * above. `appConfigPath()` lives under `app.getPath("userData")`, which on
 * macOS resolves to `~/Library/Application Support/Geode/` (inside the
 * user's home, user-owned). The managed-policy path below is
 * `/Library/Application Support/Geode/` at the filesystem root (no `~`) —
 * owned by an admin/root account under default OS permissions. That's the
 * entire tamper-resistance story for v1; see docs/adr/0002.
 *
 * `GEODE_POLICY_PATH` overrides the OS default so tests (and e2e specs) can
 * point at a temp file instead of requiring root writes to a real system
 * path — never touch the real system paths from tests/CI.
 */
function policyFilePath(): string {
  if (process.env.GEODE_POLICY_PATH) return process.env.GEODE_POLICY_PATH;
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/Geode/managed-policy.json";
    case "win32":
      return path.join(process.env.ProgramData ?? "C:\\ProgramData", "Geode", "managed-policy.json");
    default:
      return "/etc/geode/managed-policy.json";
  }
}

/**
 * Read + validate the managed policy file fresh on every call — no
 * caching, no file watcher (see docs/adr/0002 "Live-apply vs. read-once").
 * Fails open (returns `null`) on a missing file, unreadable file, or
 * invalid JSON; `validatePolicy` handles fail-open for structurally
 * invalid-but-parseable content (bad `policyVersion`/`mode`/etc).
 */
function loadManagedPolicy(): ManagedPolicy | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(policyFilePath(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Managed policy: failed to read/parse policy file; ignoring (fail open).", err);
    }
    return null;
  }
  return validatePolicy(raw);
}

/** Resolve a vault-relative path and refuse anything escaping the vault root. */
function resolveVaultPath(win: BrowserWindow, rel: string): string {
  const session = sessions.get(win.id);
  if (!session) throw new Error("No vault open");
  const abs = path.resolve(session.root, rel);
  if (abs !== session.root && !abs.startsWith(session.root + path.sep)) {
    throw new Error(`Path escapes vault: ${rel}`);
  }
  return abs;
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/**
 * `stats.birthtimeMs` is unreliable on some filesystems (e.g. some Linux
 * ext filesystems report it as 0, meaning "unavailable") — fall back to
 * mtime in that case so `file.ctime` never reports an epoch-zero date.
 */
function birthtimeOf(st: fs.Stats | null): number {
  if (!st) return 0;
  return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
}

async function listVaultFiles(
  root: string
): Promise<{ path: string; isFolder: boolean; mtime: number; ctime: number; size: number }[]> {
  const out: { path: string; isFolder: boolean; mtime: number; ctime: number; size: number }[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // hidden files incl. .geode config dir
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        const st = await fsp.stat(abs).catch(() => null);
        out.push({ path: toRel(root, abs), isFolder: true, mtime: st?.mtimeMs ?? 0, ctime: birthtimeOf(st), size: 0 });
        await walk(abs);
      } else if (e.isFile()) {
        const st = await fsp.stat(abs).catch(() => null);
        out.push({
          path: toRel(root, abs),
          isFolder: false,
          mtime: st?.mtimeMs ?? 0,
          ctime: birthtimeOf(st),
          size: st?.size ?? 0,
        });
      }
    }
  }
  await walk(root);
  return out;
}

function startWatcher(win: BrowserWindow, root: string): FSWatcher {
  const watcher = chokidar.watch(root, {
    ignored: (p) => path.basename(p).startsWith("."),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  const send = (event: string, abs: string) => {
    if (win.isDestroyed()) return;
    const relative = toRel(root, abs);
    win.webContents.send("vault-event", { event, path: relative });
    if (event === "create" || event === "modify" || event === "delete") {
      sessions.get(win.id)?.indexer?.postVaultEvent(event, relative);
    }
  };
  watcher
    .on("add", (p) => send("create", p))
    .on("change", (p) => send("modify", p))
    .on("unlink", (p) => send("delete", p))
    .on("addDir", (p) => send("create-folder", p))
    .on("unlinkDir", (p) => send("delete-folder", p));
  return watcher;
}

function registerIpc() {
  ipcMain.handle("power-save-blocker-acquire", (e) => {
    const ownerId = e.sender.id;
    if (!powerSaveBlockerOwners.has(ownerId)) {
      powerSaveBlockerOwners.add(ownerId);
      e.sender.once("destroyed", () => {
        powerSaveBlockers.releaseOwner(ownerId);
        powerSaveBlockerOwners.delete(ownerId);
      });
    }
    return powerSaveBlockers.acquire(ownerId);
  });

  ipcMain.handle("power-save-blocker-release", (e, token: unknown) => {
    if (typeof token !== "string") return false;
    return powerSaveBlockers.release(e.sender.id, token);
  });

  ipcMain.handle("choose-vault", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const result = await dialog.showOpenDialog(win, {
      title: "Open folder as vault",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("open-vault", async (e, vaultPath: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const st = await fsp.stat(vaultPath).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`Not a folder: ${vaultPath}`);
    const prev = sessions.get(win.id);
    if (prev?.watcher) await prev.watcher.close();
    if (prev?.indexer) await prev.indexer.shutdown();
    const root = path.resolve(vaultPath);
    const files = await listVaultFiles(root);
    let indexer: MetadataIndexerHost | null = null;
    let indexerReady: Promise<unknown | null> = Promise.resolve(null);
    try {
      const child = utilityProcess.fork(path.join(__dirname, "indexer-process.js"));
      indexer = new MetadataIndexerHost(child, (message) => {
        if (!win.isDestroyed()) win.webContents.send("metadata-indexer-message", message);
      });
      const markdownFiles: MetadataFileStat[] = files
        .filter((file) => !file.isFolder && file.path.toLowerCase().endsWith(".md"))
        .map((file) => ({ path: file.path, mtimeMs: file.mtime, size: file.size }));
      indexerReady = indexer.initialize(root, markdownFiles);
    } catch (error) {
      console.error("Metadata utility process unavailable; using renderer fallback", error);
    }
    sessions.set(win.id, { root, watcher: startWatcher(win, root), indexer, indexerReady });
    const cfg = loadConfig();
    cfg.recentVaults = [root, ...cfg.recentVaults.filter((v) => v !== root)].slice(0, 10);
    cfg.lastVault = root;
    saveConfig(cfg);
    win.setTitle(`${path.basename(root)} — Geode`);
    return { root, name: path.basename(root), files };
  });

  ipcMain.handle("get-recent-vaults", () => {
    const cfg = loadConfig();
    return cfg.recentVaults.filter((v) => fs.existsSync(v));
  });

  // Enterprise-managed plugin policy — machine-level, not vault-scoped (see
  // policyFilePath()/loadManagedPolicy() above and docs/adr/0002). No
  // caching: re-read on every call so a new vault window opened in an
  // already-running process picks up a just-changed policy immediately.
  ipcMain.handle("get-plugin-policy", () => loadManagedPolicy());

  ipcMain.handle("vault-list", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const session = sessions.get(win.id);
    if (!session) throw new Error("No vault open");
    return listVaultFiles(session.root);
  });

  ipcMain.handle("vault-read", async (e, rel: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    return fsp.readFile(resolveVaultPath(win, rel), "utf8");
  });

  ipcMain.handle("vault-read-binary", async (e, rel: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const buf = await fsp.readFile(resolveVaultPath(win, rel));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle("vault-write", async (e, rel: string, data: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const abs = resolveVaultPath(win, rel);
    return withPathLock([abs], async () => {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, data, "utf8");
      const st = await fsp.stat(abs);
      return { mtime: st.mtimeMs, ctime: birthtimeOf(st), size: st.size };
    });
  });

  ipcMain.handle("vault-mkdir", async (e, rel: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    await fsp.mkdir(resolveVaultPath(win, rel), { recursive: true });
  });

  ipcMain.handle("vault-delete", async (e, rel: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const abs = resolveVaultPath(win, rel);
    return withPathLock([abs], async () => {
      // Move to OS trash rather than permanent deletion (Obsidian's default).
      await shell.trashItem(abs);
    });
  });

  ipcMain.handle("vault-rename", async (e, rel: string, newRel: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const from = resolveVaultPath(win, rel);
    const to = resolveVaultPath(win, newRel);
    return withPathLock([from, to], async () => {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
    });
  });

  ipcMain.handle("vault-exists", async (e, rel: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    try {
      await fsp.access(resolveVaultPath(win, rel));
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("metadata-cache-read", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const session = sessions.get(win.id);
    return session ? readMetadataCache(session.root) : null;
  });

  ipcMain.handle("metadata-cache-write", async (e, data: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const session = sessions.get(win.id);
    if (session) await writeMetadataCache(session.root, data);
  });

  ipcMain.handle("metadata-indexer-start", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    return sessions.get(win.id)?.indexerReady ?? null;
  });

  // Per-vault config stored in <vault>/.geode/<name>.json
  ipcMain.handle("config-read", async (e, name: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const session = sessions.get(win.id);
    if (!session) return null;
    try {
      return JSON.parse(
        await fsp.readFile(path.join(session.root, ".geode", `${name}.json`), "utf8")
      );
    } catch {
      return null;
    }
  });

  ipcMain.handle("config-write", async (e, name: string, data: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const session = sessions.get(win.id);
    if (!session) return;
    const dir = path.join(session.root, ".geode");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2));
  });

  ipcMain.handle("get-vault-root", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    return sessions.get(win.id)?.root ?? null;
  });

  // Plugin discovery: list subfolders of <vault>/.geode/plugins/ that look
  // like a plugin (contain a manifest.json). Reading/writing manifest.json,
  // main.js, and data.json themselves goes through the generic vault-read/
  // vault-write/vault-exists handlers above, which are not restricted to
  // indexed (non-dotfile) vault paths.
  ipcMain.handle("plugins-list-ids", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const session = sessions.get(win.id);
    if (!session) return [];
    const pluginsDir = path.join(session.root, ".geode", "plugins");
    let entries;
    try {
      entries = await fsp.readdir(pluginsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const hasManifest = await fsp
        .access(path.join(pluginsDir, entry.name, "manifest.json"))
        .then(() => true)
        .catch(() => false);
      if (hasManifest) ids.push(entry.name);
    }
    return ids;
  });

  // Community themes: subdirectories of <vault>/.geode/themes/ that contain a
  // theme.css (Obsidian's theme layout). Returns their names for the picker.
  ipcMain.handle("themes-list", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const session = sessions.get(win.id);
    if (!session) return [];
    const themesDir = path.join(session.root, ".geode", "themes");
    let entries;
    try {
      entries = await fsp.readdir(themesDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const hasCss = await fsp
        .access(path.join(themesDir, entry.name, "theme.css"))
        .then(() => true)
        .catch(() => false);
      if (hasCss) names.push(entry.name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  });

  ipcMain.handle("open-external", (_e, url: string) => {
    // Web links and mailto: addresses only — never file:/javascript:/etc.
    if (/^(https?:\/\/|mailto:)/i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle("open-local-file", async (e, href: string) => {
    const target = parseLocalFileHref(href);
    if (!target || !path.isAbsolute(target.path)) return { kind: "rejected" } as const;

    const win = BrowserWindow.fromWebContents(e.sender);
    const session = win ? sessions.get(win.id) : null;
    if (!session) return { kind: "rejected" } as const;

    const stat = await fsp.stat(target.path).catch(() => null);
    if (!stat?.isFile()) return { kind: "rejected" } as const;

    // Resolve symlinks before deciding whether a path is vault-contained.
    // A symlink inside the vault that points outside must use the OS handler.
    const [realRoot, realTarget] = await Promise.all([
      fsp.realpath(session.root).catch(() => null),
      fsp.realpath(target.path).catch(() => null),
    ]);
    if (!realRoot || !realTarget) return { kind: "rejected" } as const;
    const realRel = path.relative(realRoot, realTarget);
    if (realRel !== "" && !realRel.startsWith(`..${path.sep}`) && realRel !== ".." && !path.isAbsolute(realRel)) {
      const rel = toRel(session.root, path.resolve(target.path));
      if (!rel.startsWith("../") && rel !== "..") {
        return { kind: "vault", path: rel, line: target.line, column: target.column } as const;
      }
    }

    const error = await shell.openPath(realTarget);
    return error ? ({ kind: "rejected" } as const) : ({ kind: "external" } as const);
  });

  // Community install-from-GitHub (see src/main/community.ts). Resolve returns
  // install metadata for the modal preview; install downloads + writes files.
  // Both re-resolve from the caller's owner/repo spec — the renderer never
  // supplies file URLs or paths.
  ipcMain.handle("community-resolve", async (_e, spec: string, opts: ResolveOpts) => {
    return resolveCommunity(spec, opts ?? {});
  });

  ipcMain.handle("community-install", async (e, spec: string, opts: ResolveOpts) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const session = sessions.get(win.id);
    if (!session) throw new Error("No vault open");
    return installCommunity(session.root, spec, opts ?? {});
  });

  // Web Viewer's "Import cookies from Chrome" (src/main/chrome-cookies.ts).
  // Done in the main process: it needs filesystem + Keychain (child_process)
  // access, and keeps the decrypted cookie values out of the renderer beyond
  // what's actually injected into the persist:webviewer session.
  ipcMain.handle("chrome-list-profiles", () => listChromeProfiles());
  ipcMain.handle("chrome-import-cookies", (_e, profileDir: string) => importChromeCookies(profileDir));

  // Per-process CPU/memory telemetry for the Settings -> Performance tab
  // (src/renderer/settings/performance-tab.ts). Polled from the renderer on
  // a timer, so no caching here -- always return a fresh snapshot.
  ipcMain.handle("get-process-metrics", () => getProcessMetricsSnapshot());
  ipcMain.handle("crash-recovery-state", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const state = win ? crashStates.get(win.id) : undefined;
    return { suppressPlugins: state?.suppressPlugins ?? false, entries: crashJournal().read() };
  });
  ipcMain.handle("crash-diagnostic", async (e, entry: CrashDiagnostic) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    recordDiagnostic(win ? crashStates.get(win.id) : undefined, {
      at: Date.now(), category: "renderer-diagnostic", message: entry.type,
    });
    return crashJournal().append(entry);
  });
  ipcMain.handle("crash-active-plugins", (e, pluginIds: string[]) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const state = win ? crashStates.get(win.id) : undefined;
    if (state) {
      state.activePlugins = [...pluginIds];
      recordDiagnostic(state, {
        at: Date.now(), category: "plugins", message: "active-plugins-updated",
        metadata: { pluginIds: pluginIds.map((id) => sanitizeDiagnosticValue(id, { maxLength: 100 })).join(",") },
      });
    }
  });
  ipcMain.handle("crash-recovery-leave", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const state = win ? crashStates.get(win.id) : undefined;
    if (state) state.suppressPlugins = false;
  });
  ipcMain.on("renderer-heartbeat", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const state = win ? crashStates.get(win.id) : undefined;
    if (state) state.lastHeartbeat = Date.now();
  });
}

const isHeadless =
  process.env.GEODE_HEADLESS === "1" ||
  process.argv.includes("--headless");

function createWindow(suppressPlugins = false) {
  const indexPath = path.join(__dirname, "..", "src", "renderer", "index.html");
  const indexUrl = pathToFileURL(indexPath).href;
  const win = new BrowserWindow({
    show: !isHeadless,
    width: 1280,
    height: 840,
    minWidth: 640,
    minHeight: 440,
    title: "Geode",
    icon: path.join(__dirname, "..", "resources", "icon.png"),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
      // Obsidian's own desktop model: the renderer runs with full Node
      // integration so plugins can `require('fs')`/`require('child_process')`
      // /`require('electron')` directly. Claude Threads (and plugins like
      // it) spawn subprocesses and touch the filesystem, which cannot be
      // faithfully bridged over a contextBridge (streams/EventEmitters/
      // ChildProcess don't survive the proxy). This is a deliberate trust
      // decision: Geode, like Obsidian, treats locally-installed plugins as
      // trusted code. See src/renderer/plugin-manager.ts for how the plugin
      // require() shim delegates unknown specifiers to this real Node require.
      contextIsolation: false,
      nodeIntegration: true,
      // Keep spellcheck etc. defaults; sandbox must stay off for nodeIntegration.
      sandbox: false,
      // Enables the <webview> tag, used by the Web Viewer's WebView view
      // (src/renderer/views/web-view.ts) to host in-app browser tabs. Its
      // partition="persist:webviewer" gives it an isolated, persistent
      // session separate from the app's own cookie jar.
      webviewTag: true,
    },
  });
  const state: CrashState = {
    suppressPlugins,
    activePlugins: [],
    lastHeartbeat: Date.now(),
    recovering: suppressPlugins,
    breadcrumbs: new BoundedBuffer(100),
    consoleEntries: new BoundedBuffer(100),
    knownDumps: [],
    lastProcessMetrics: [],
  };
  crashStates.set(win.id, state);
  void listCrashDumps(app.getPath("crashDumps")).then((dumps) => { state.knownDumps = dumps; }).catch(() => {});
  recordDiagnostic(state, { at: Date.now(), category: "lifecycle", message: "window-created", metadata: { suppressPlugins } });
  win.loadFile(indexPath);

  const recoverRenderer = async (diagnostic: CrashDiagnostic) => {
    const state = crashStates.get(win.id);
    if (!state) return;
    await crashJournal().append(diagnostic).catch(() => {});
    state.suppressPlugins = true;
    if (state.recovering || win.isDestroyed()) return;
    state.recovering = true;
    setTimeout(() => {
      // A crashed WebContents is not reliably reusable on every Electron/macOS
      // combination. Replace the window and carry recovery state forward.
      // Creating first avoids window-all-closed quitting the app on Windows/Linux.
      createWindow(true);
      if (!win.isDestroyed()) win.destroy();
    }, 250);
  };

  win.webContents.on("render-process-gone", (_event, details) => {
    const state = crashStates.get(win.id);
    if (!state || details.reason === "clean-exit") return;
    void (async () => {
      // Crashpad may finish the dump immediately after this event. A short wait
      // improves correlation without delaying or blocking renderer recovery.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const dumps = await listCrashDumps(app.getPath("crashDumps")).catch(() => []);
      const newDumps = dumps.filter((dump) => !state.knownDumps.some((known) => known.name === dump.name));
      let processMetrics = state.lastProcessMetrics;
      try { processMetrics = getProcessMetricsSnapshot(); } catch { /* retain the last pre-crash snapshot */ }
      await recoverRenderer(buildRendererIncident({
        incidentId: randomUUID(),
        at: Date.now(),
        reason: details.reason,
        exitCode: details.exitCode,
        activePlugins: [...state.activePlugins],
        suppressPlugins: state.suppressPlugins,
        recovering: state.recovering,
        breadcrumbs: state.breadcrumbs.values(),
        consoleEntries: state.consoleEntries.values(),
        processMetrics,
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        platform: process.platform,
        arch: process.arch,
        uptimeSeconds: Math.round(process.uptime()),
        windowUrl: sanitizeDiagnosticValue(win.webContents.getURL()),
        dumpFiles: newDumps,
      }));
      void pruneCrashDumps(app.getPath("crashDumps"), 10).catch(() => {});
    })();
  });

  win.webContents.on("console-message", (details) => {
    recordDiagnostic(state, {
      at: Date.now(),
      category: "renderer-console",
      level: details.level,
      message: details.message,
      metadata: { lineNumber: details.lineNumber, sourceId: details.sourceId },
    }, true);
  });
  win.webContents.on("did-finish-load", () => {
    recordDiagnostic(state, { at: Date.now(), category: "lifecycle", message: "did-finish-load" });
  });

  // Do not arm until the renderer has loaded once; this avoids treating normal
  // startup/build latency as a hang. One automatic recovery only prevents loops.
  const watchdog = setInterval(() => {
    const state = crashStates.get(win.id);
    if (state) {
      try { state.lastProcessMetrics = getProcessMetricsSnapshot(); } catch { /* diagnostics are best effort */ }
    }
    if (!state || state.recovering || Date.now() - state.lastHeartbeat < 20_000) return;
    void recoverRenderer({ type: "renderer-hang", at: Date.now(), activePlugins: [...state.activePlugins] });
  }, 5_000);

  // External-link navigation hard guard (defense in depth behind the
  // renderer-side interceptor in src/renderer/app.ts). The main window must
  // only ever display the app's own index.html; any attempt to navigate it
  // away — e.g. a plugin-rendered <a href="https://…"> that slips past the
  // renderer interceptor — is cancelled, and web URLs are handed to the OS
  // browser instead. This is attached to the MAIN window's webContents only:
  // the in-app Web Viewer runs in a separate <webview> with its own
  // webContents (partition="persist:webviewer", see
  // src/renderer/views/web-view.ts), so in-app browsing follows links
  // normally and is unaffected by this guard.
  win.webContents.on("will-navigate", (e, url) => {
    recordDiagnostic(state, { at: Date.now(), category: "navigation", message: "will-navigate", metadata: { url } });
    if (isAllowedAppNavigation(url, indexUrl)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => {
    clearInterval(watchdog);
    const session = sessions.get(win.id);
    session?.watcher?.close();
    if (session?.indexer) void session.indexer.shutdown();
    sessions.delete(win.id);
    crashStates.delete(win.id);
  });
  return win;
}

function installApplicationMenu(): void {
  const template = buildApplicationMenuTemplate(process.platform, async () => {
      try {
        const result = await dialog.showOpenDialog({
          title: "Choose a folder for Geode diagnostics",
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled || !result.filePaths[0]) return;
        const exported = await exportDiagnostics({
          destinationRoot: result.filePaths[0],
          userDataDir: app.getPath("userData"),
          crashDumpsDir: app.getPath("crashDumps"),
          manifest: {
            generatedAt: new Date().toISOString(),
            appVersion: app.getVersion(),
            electronVersion: process.versions.electron,
            platform: process.platform,
            arch: process.arch,
            privacy: "Geode copies only allowlisted diagnostic artifacts and does not intentionally read vault files, config, environment variables, prompts, IPC payloads, or plugin source. Console output and minidumps may contain sensitive fragments; inspect before sharing.",
          },
        });
        shell.showItemInFolder(exported.directory);
      } catch (error) {
        recordDiagnostic(undefined, { at: Date.now(), category: "diagnostics", level: "error", message: `export-failed: ${error}` });
      }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  if (isHeadless && process.platform === "darwin" && app.dock) {
    app.dock.hide();
  } else if (process.platform === "darwin" && app.dock) {
    // macOS ignores the per-window `icon` option, so set the dock icon
    // explicitly. This makes the Geode icon show during unpackaged dev runs;
    // packaged builds use resources/icon.icns via electron-builder.
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, "..", "resources", "icon.png"));
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }
  registerIpc();
  installApplicationMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
