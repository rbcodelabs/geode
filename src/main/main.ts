import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import chokidar, { FSWatcher } from "chokidar";

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
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, data, "utf8");
    const st = await fsp.stat(abs);
    return { mtime: st.mtimeMs, size: st.size };
  });

  ipcMain.handle("vault-mkdir", async (e, rel: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    await fsp.mkdir(resolveVaultPath(win, rel), { recursive: true });
  });

  ipcMain.handle("vault-delete", async (e, rel: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const abs = resolveVaultPath(win, rel);
    // Move to OS trash rather than permanent deletion (Obsidian's default).
    await shell.trashItem(abs);
  });

  ipcMain.handle("vault-rename", async (e, rel: string, newRel: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)!;
    const from = resolveVaultPath(win, rel);
    const to = resolveVaultPath(win, newRel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
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

  ipcMain.handle("open-external", (_e, url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
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
      contextIsolation: true,
      nodeIntegration: false,
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
