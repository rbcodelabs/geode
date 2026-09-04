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
 *
 * The whole feature is additionally gated OFF by default behind
 * `GEODE_ENABLE_AUTO_UPDATE` — see `initAutoUpdater()` and
 * `./update-config.ts`.
 */

import { app, BrowserWindow, dialog, shell, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";
import { autoUpdater } from "electron-updater";
import { DEFAULT_UPDATE_CHECK_INTERVAL_MS, shouldCheckForUpdates } from "./update-scheduler";
import {
  AUTO_UPDATE_OPT_IN_ENV,
  UPDATE_FEED_URL_ENV,
  resolveAutoUpdateGate,
  resolveUpdateFeedUrl,
} from "./update-config";

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

/**
 * Every promise in this module is fire-and-forget — a dialog the user never
 * answers, a download that stalls, a browser that won't open. None of them
 * should surface as an unhandled rejection in the main process.
 */
function logRejection(what: string): (err: unknown) => void {
  return (err) => console.error(`Auto-updater: ${what} failed:`, err);
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
    })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.downloadUpdate().catch(logRejection("downloadUpdate()"));
        }
      })
      .catch(logRejection("update-available dialog"));
  });

  autoUpdater.on("update-not-available", () => {
    lastCheckedAt = Date.now();
    if (manualCheckInFlight) {
      showMessageBox({
        type: "info",
        message: "You're up to date",
        buttons: ["OK"],
      }).catch(logRejection("up-to-date dialog"));
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
    })
      .then((result) => {
        if (result.response === 0) autoUpdater.quitAndInstall();
      })
      .catch(logRejection("update-downloaded dialog"));
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
      })
        .then((result) => {
          if (result.response === 0) {
            shell.openExternal(RELEASES_URL).catch(logRejection("openExternal(releases)"));
          }
        })
        .catch(logRejection("update-error dialog"));
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
 * Wire up electron-updater and start the background check schedule.
 *
 * OFF BY DEFAULT. Two things must both be true: the app is packaged, AND
 * `GEODE_ENABLE_AUTO_UPDATE` is explicitly set (see `update-config.ts` and
 * docs/adr/0003-auto-update-mechanism.md). Being packaged alone is not enough —
 * ADR 0003's documented mitigation for the `quitAndInstall()` ad-hoc-signing
 * risk (the "Open Releases Page" dialog) only fires on a *manual* check, and
 * nothing in the app triggers one, so an unverified update path would fail
 * silently for users. The gate comes off when that path has actually been
 * exercised on a packaged build.
 *
 * When gated off: no network calls, no dialogs, no timers — just one log line
 * saying why.
 */
export function initAutoUpdater(): void {
  const gate = resolveAutoUpdateGate(process.env, app.isPackaged);
  if (!gate.enabled) {
    console.log(`Auto-updater: disabled — ${gate.reason}.`);
    return;
  }

  const feed = resolveUpdateFeedUrl(process.env[UPDATE_FEED_URL_ENV]);
  if (feed.kind === "invalid") {
    // Fail closed: an operator who set a feed meant to use it, so silently
    // falling back to the production feed would be worse than not updating.
    console.error(
      `Auto-updater: disabled — ${UPDATE_FEED_URL_ENV}="${feed.raw}" rejected: ${feed.reason}.`
    );
    return;
  }
  if (feed.kind === "custom") {
    autoUpdater.setFeedURL({ provider: "generic", url: feed.url });
  }
  autoUpdater.autoDownload = false;

  wireEventHandlers();

  setTimeout(() => runScheduledCheck(), STARTUP_CHECK_DELAY_MS);
  setInterval(() => runScheduledCheck(), SCHEDULER_TICK_MS);
}

/**
 * Manual "check now" trigger (wired to the `updater-check` IPC handler).
 * Returns `disabled` — and says why in a dialog — whenever `initAutoUpdater()`
 * would have gated itself off, since none of the event handlers are wired in
 * that case and a check would go nowhere. Otherwise marks the in-flight check
 * as manual so `update-not-available`/`error` surface a dialog instead of
 * staying silent (the background-check behavior).
 */
export async function checkForUpdatesManually(): Promise<{ status: "checking" | "disabled" }> {
  const gate = resolveAutoUpdateGate(process.env, app.isPackaged);
  if (!gate.enabled) {
    await showMessageBox({
      type: "info",
      message: app.isPackaged
        ? `Updates are turned off in this build (set ${AUTO_UPDATE_OPT_IN_ENV} to enable them)`
        : "Updates are disabled in development builds",
      buttons: ["OK"],
    }).catch(logRejection("updates-disabled dialog"));
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
