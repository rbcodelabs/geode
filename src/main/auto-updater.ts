/**
 * Auto-update wiring around electron-updater's singleton `autoUpdater`
 * (docs/adr/0003-auto-update-mechanism.md). macOS-only in practice — no
 * win/linux `electron-builder` targets exist in package.json, so this code
 * is never exercised on those platforms, but nothing here is
 * platform-gated beyond that.
 *
 * Every state transition that matters to the user goes through
 * `dialog.showMessageBox` — there is no silent/forced update. Downloads
 * never start without an explicit "Download Update" click
 * (`autoUpdater.autoDownload = false`), and installs never happen without
 * an explicit "Restart Now" click.
 */

import { app, BrowserWindow, dialog, shell, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";
import { autoUpdater } from "electron-updater";
import { DEFAULT_UPDATE_CHECK_INTERVAL_MS, shouldCheckForUpdates } from "./update-scheduler";

/** Delay before the first startup check, so it doesn't compete with initial window paint/vault load. */
const STARTUP_CHECK_DELAY_MS = 5_000;
/** How often the background scheduler wakes up to decide whether it's time to check again. */
const SCHEDULER_TICK_MS = 30 * 60 * 1000;

const RELEASES_URL = "https://github.com/rbcodelabs/geode/releases/latest";

let lastCheckedAt: number | null = null;
/** True only while the in-flight check was triggered by the user (manual "check now"), not the background scheduler. */
let manualCheckInFlight = false;

function targetWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined;
}

/**
 * `dialog.showMessageBox` has no overload that accepts an explicit
 * `undefined` window argument — pass the window only when one exists,
 * otherwise call the window-less overload.
 */
function showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const win = targetWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

function wireEventHandlers(): void {
  autoUpdater.on("update-available", (info) => {
    lastCheckedAt = Date.now();
    showMessageBox({
      type: "info",
      message: `Geode ${info.version} is available`,
      buttons: ["Download Update", "Later"],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) autoUpdater.downloadUpdate();
    });
  });

  autoUpdater.on("update-not-available", () => {
    lastCheckedAt = Date.now();
    if (manualCheckInFlight) {
      showMessageBox({
        type: "info",
        message: "You're up to date",
        buttons: ["OK"],
      });
    }
    manualCheckInFlight = false;
  });

  autoUpdater.on("download-progress", (progress) => {
    const win = targetWindow();
    win?.webContents.send("updater-progress", { percent: progress.percent });
  });

  autoUpdater.on("update-downloaded", () => {
    showMessageBox({
      type: "info",
      message: "Update downloaded — restart Geode to finish installing",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-updater error:", err);
    lastCheckedAt = Date.now();
    if (manualCheckInFlight) {
      showMessageBox({
        type: "error",
        message: `Update check failed: ${err.message}`,
        buttons: ["Open Releases Page", "Dismiss"],
        defaultId: 0,
        cancelId: 1,
      }).then((result) => {
        if (result.response === 0) shell.openExternal(RELEASES_URL);
      });
    }
    manualCheckInFlight = false;
  });
}

function runScheduledCheck(): void {
  if (!shouldCheckForUpdates(lastCheckedAt, Date.now())) return;
  manualCheckInFlight = false;
  autoUpdater.checkForUpdates().catch((err) => {
    // checkForUpdates() already emits an 'error' event for handler-visible
    // failures; this catch only guards against an unhandled rejection.
    console.error("Auto-updater: background check failed:", err);
  });
}

/**
 * Wire up electron-updater and start the background check schedule. No-op
 * (besides a log line) when running unpackaged (`npm start`, Playwright's
 * `app.isPackaged === false` e2e launch) — no network calls, no dialogs, no
 * timers started.
 */
export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    console.log("Auto-updater: disabled in development (app.isPackaged === false).");
    return;
  }

  const feedUrl = process.env.GEODE_UPDATE_FEED_URL;
  if (feedUrl) {
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
  }
  autoUpdater.autoDownload = false;

  wireEventHandlers();

  setTimeout(() => runScheduledCheck(), STARTUP_CHECK_DELAY_MS);
  setInterval(() => runScheduledCheck(), SCHEDULER_TICK_MS);
}

/**
 * Manual "check now" trigger (wired to the `updater-check` IPC handler).
 * In dev, shows an info dialog instead of touching the network. In
 * packaged mode, marks the in-flight check as manual so
 * `update-not-available`/`error` surface a dialog instead of staying
 * silent (the background-check behavior).
 */
export async function checkForUpdatesManually(): Promise<{ status: "checking" | "disabled" }> {
  if (!app.isPackaged) {
    await showMessageBox({
      type: "info",
      message: "Updates are disabled in development builds",
      buttons: ["OK"],
    });
    return { status: "disabled" };
  }

  manualCheckInFlight = true;
  autoUpdater.checkForUpdates().catch((err) => {
    console.error("Auto-updater: manual check failed:", err);
  });
  return { status: "checking" };
}

// Re-exported for anything that wants the configured default without
// importing update-scheduler directly (kept for discoverability only).
export { DEFAULT_UPDATE_CHECK_INTERVAL_MS };
