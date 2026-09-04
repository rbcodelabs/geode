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
 * an explicit "Restart Now" click (`autoUpdater.autoInstallOnAppQuit =
 * false` — see `initAutoUpdater()`; without it, "Later" silently defers the
 * install to the next quit rather than declining it).
 *
 * The whole feature is additionally gated OFF by default behind
 * `GEODE_ENABLE_AUTO_UPDATE` — see `initAutoUpdater()` and
 * `./update-config.ts`.
 */

import { app, BrowserWindow, dialog, shell, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";
import { autoUpdater } from "electron-updater";
import { DEFAULT_UPDATE_CHECK_INTERVAL_MS, shouldCheckForUpdates } from "./update-scheduler";
import { resolveUpdaterState } from "./update-config";

/** Delay before the first startup check, so it doesn't compete with initial window paint/vault load. */
const STARTUP_CHECK_DELAY_MS = 5_000;
/** How often the background scheduler wakes up to decide whether it's time to check again. */
const SCHEDULER_TICK_MS = 30 * 60 * 1000;

const RELEASES_URL = "https://github.com/rbcodelabs/geode/releases/latest";

let lastCheckedAt: number | null = null;
/** True only while the in-flight check was triggered by the user (manual "check now"), not the background scheduler. */
let manualCheckInFlight = false;
/** True between an explicit "Restart Now" click and the install either happening or failing. */
let installRequested = false;

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

/**
 * The "something went wrong, here's a way out" dialog — ADR 0003's permanent
 * safety net. Always offers the releases page, so a failure degrades to "go
 * get it yourself" rather than a dead end.
 */
function showRecoverableFailure(message: string, detail?: string): void {
  showMessageBox({
    type: "error",
    message,
    ...(detail === undefined ? {} : { detail }),
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
        if (result.response === 0) {
          installRequested = true;
          autoUpdater.quitAndInstall();
        }
      })
      .catch(logRejection("update-downloaded dialog"));
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-updater error:", err);
    lastCheckedAt = Date.now();

    // An error after an explicit "Restart Now" is not a background hiccup — the
    // user asked for something and it did not happen. With
    // `autoInstallOnAppQuit = false`, `MacUpdater.quitAndInstall()` must first
    // pull the artifact from the local proxy server
    // (`MacUpdater.js` `quitAndInstall` → `nativeUpdater.checkForUpdates()`);
    // if that fetch errors, `handleUpdateDownloaded()` never fires and the app
    // simply never restarts. `manualCheckInFlight` is false by then, so without
    // this branch the click would die in `console.error` and the user would be
    // left staring at an app that ignored them.
    if (installRequested) {
      installRequested = false;
      manualCheckInFlight = false;
      showRecoverableFailure(
        `Update install failed: ${err.message}`,
        "Geode has not been updated and is still running the current version. You can install the new version manually from the releases page."
      );
      return;
    }

    if (manualCheckInFlight) {
      showRecoverableFailure(`Update check failed: ${err.message}`);
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
  const state = resolveUpdaterState(process.env, app.isPackaged);
  if (!state.live) {
    if (state.gatePassed) {
      // Fail closed. We're past the packaged + opt-in gate, so the
      // electron-updater singleton is live in this process and something else
      // could still reach `checkForUpdates()`. Its defaults are
      // `autoDownload = true` / `autoInstallOnAppQuit = true`
      // (electron-updater/out/AppUpdater.js:109,114), which would turn any such
      // check into a silent download-and-staged-install against whatever feed
      // resolved — including the baked-in production one the operator was
      // trying to override. Pin both off before bailing out. Not reached when
      // the gate itself failed: unpackaged builds must not touch the singleton
      // at all (accessing it constructs it).
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      console.error(`Auto-updater: disabled — ${state.reason}.`);
    } else {
      console.log(`Auto-updater: disabled — ${state.reason}.`);
    }
    return;
  }

  autoUpdater.autoDownload = false;
  // Not merely defensive, and NOT the `BaseUpdater.addQuitHandler()` mechanism
  // — `MacUpdater extends AppUpdater` (MacUpdater.js:13), not `BaseUpdater`, so
  // that quit-handler code never runs here and this file is macOS-only. The
  // path that matters is `MacUpdater.js:218-224`: `dispatchUpdateDownloaded()`
  // — which is what raises our "Restart Now"/"Later" dialog — is followed in
  // the SAME synchronous block by `if (this.autoInstallOnAppQuit)
  // { this.nativeUpdater.checkForUpdates() }`, handing the artifact to
  // Squirrel.Mac and staging the install before the user has answered.
  // Clicking "Later" would then not decline the install, it would defer it to
  // the next quit: a silent, unclicked route into exactly the ad-hoc-signed
  // self-replace path this whole feature is gated off to keep dormant, and a
  // direct contradiction of the no-install-without-a-click constraint at the
  // top of this file and in ADR 0003.
  autoUpdater.autoInstallOnAppQuit = false;
  if (state.feed.kind === "custom") {
    autoUpdater.setFeedURL({ provider: "generic", url: state.feed.url });
  }

  wireEventHandlers();

  setTimeout(() => runScheduledCheck(), STARTUP_CHECK_DELAY_MS);
  setInterval(() => runScheduledCheck(), SCHEDULER_TICK_MS);
}

/**
 * Manual "check now" trigger (wired to the `updater-check` IPC handler).
 *
 * Consumes `resolveUpdaterState` — the SAME decision `initAutoUpdater()` uses,
 * deliberately not a subset of it. If `initAutoUpdater()` refused to run, no
 * event handlers are wired and no feed override was applied, so a check here
 * would either go nowhere visible or go somewhere wrong; it returns `disabled`
 * with the reason surfaced instead. Otherwise it marks the in-flight check as
 * manual so `update-not-available`/`error` surface a dialog rather than staying
 * silent (the background-check behavior).
 */
export async function checkForUpdatesManually(): Promise<{ status: "checking" | "disabled" }> {
  const state = resolveUpdaterState(process.env, app.isPackaged);
  if (!state.live) {
    // `state.reason` is written for a log line, not for an end user. Surface it
    // only when the gate passed and the FEED was rejected — that's an operator
    // misconfiguration and they need the specifics to fix it. In the default
    // no-opt-in case the reason is a sentence about a repo doc path, so keep
    // the user-facing text terse.
    await showMessageBox({
      type: "info",
      message: !app.isPackaged
        ? "Updates are disabled in development builds"
        : state.gatePassed
          ? "Updates are turned off in this build — the configured update feed was rejected"
          : "Updates are turned off in this build",
      ...(state.gatePassed ? { detail: state.reason } : {}),
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
