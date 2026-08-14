import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import chokidar, { FSWatcher } from "chokidar";
import { installCommunity, resolveCommunity } from "./community";
import type { ResolveOpts } from "./github-resolve";
import { validatePolicy, type ManagedPolicy } from "../renderer/policy";
import { withPathLock } from "./path-lock";
import { listChromeProfiles, importChromeCookies } from "./chrome-cookies";

// Chromium gates SharedArrayBuffer behind cross-origin isolation by default.
// Obsidian enables it so plugins (and the libraries they bundle, e.g. the
// Claude Agent SDK) can use it; Geode does the same for plugin
// compatibility. Must be set before app 'ready'.
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");

interface VaultSession {
  root: string;
  watcher: FSWatcher | null;
}

const sessions = new Map<number, VaultSession>();

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

async function listVaultFiles(root: string): Promise<{ path: string; isFolder: boolean; mtime: number; size: number }[]> {
  const out: { path: string; isFolder: boolean; mtime: number; size: number }[] = [];
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
        out.push({ path: toRel(root, abs), isFolder: true, mtime: st?.mtimeMs ?? 0, size: 0 });
        await walk(abs);
      } else if (e.isFile()) {
        const st = await fsp.stat(abs).catch(() => null);
        out.push({ path: toRel(root, abs), isFolder: false, mtime: st?.mtimeMs ?? 0, size: st?.size ?? 0 });
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
    win.webContents.send("vault-event", { event, path: toRel(root, abs) });
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
    const root = path.resolve(vaultPath);
    sessions.set(win.id, { root, watcher: startWatcher(win, root) });
    const cfg = loadConfig();
    cfg.recentVaults = [root, ...cfg.recentVaults.filter((v) => v !== root)].slice(0, 10);
    cfg.lastVault = root;
    saveConfig(cfg);
    win.setTitle(`${path.basename(root)} — Geode`);
    return { root, name: path.basename(root), files: await listVaultFiles(root) };
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
      return { mtime: st.mtimeMs, size: st.size };
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
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
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
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 640,
    minHeight: 440,
    title: "Geode",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
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
  win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
  win.on("closed", () => {
    const session = sessions.get(win.id);
    session?.watcher?.close();
    sessions.delete(win.id);
  });
  return win;
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
