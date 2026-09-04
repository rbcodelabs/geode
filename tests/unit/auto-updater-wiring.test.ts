/**
 * Wiring tests for `initAutoUpdater()` / `checkForUpdatesManually()` with the
 * `electron` and `electron-updater` singletons mocked — no real app instance.
 *
 * `update-config.test.ts` covers the pure decisions, but the decisions being
 * right is not the same as both entry points obeying them, and the gap between
 * those two things is exactly where a bug lived: `initAutoUpdater()` consulted
 * the gate AND the feed, while `checkForUpdatesManually()` consulted only the
 * gate. A packaged, opted-in build with a rejected `http://` feed left
 * `initAutoUpdater()` returning early — before `autoDownload = false`, before
 * any handler was wired — while a manual check passed the gate and called
 * `autoUpdater.checkForUpdates()` against the baked-in production feed. With
 * electron-updater's defaults (`autoDownload = true`,
 * `autoInstallOnAppQuit = true`) that is a silent download and an install on
 * quit, with no dialogs at all.
 *
 * So these tests assert BEHAVIOR at the seam — which functions were called on
 * the updater — rather than what the pure helpers returned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_UPDATE_OPT_IN_ENV, UPDATE_FEED_URL_ENV } from "../../src/main/update-config";

const mocks = vi.hoisted(() => ({
  // Seeded with electron-updater's REAL defaults, so a test can catch code
  // that bails out without pinning them off.
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    quitAndInstall: vi.fn(),
  },
  app: { isPackaged: true },
  showMessageBox: vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false })),
  openExternal: vi.fn(() => Promise.resolve()),
}));

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showMessageBox: mocks.showMessageBox },
  shell: { openExternal: mocks.openExternal },
}));

vi.mock("electron-updater", () => ({ autoUpdater: mocks.autoUpdater }));

type Updater = typeof import("../../src/main/auto-updater");

/** Fresh module instance per test — the module holds `lastCheckedAt` state. */
async function loadUpdater(): Promise<Updater> {
  vi.resetModules();
  return import("../../src/main/auto-updater");
}

const ENV_KEYS = [AUTO_UPDATE_OPT_IN_ENV, UPDATE_FEED_URL_ENV];
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  mocks.app.isPackaged = true;
  mocks.autoUpdater.autoDownload = true;
  mocks.autoUpdater.autoInstallOnAppQuit = true;
  mocks.autoUpdater.on.mockClear();
  mocks.autoUpdater.setFeedURL.mockClear();
  mocks.autoUpdater.checkForUpdates.mockClear();
  mocks.showMessageBox.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const key of ENV_KEYS) {
    const previous = savedEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe("an invalid feed URL fails closed at BOTH entry points", () => {
  beforeEach(() => {
    process.env[AUTO_UPDATE_OPT_IN_ENV] = "1";
    process.env[UPDATE_FEED_URL_ENV] = "http://staging.internal/geode/";
  });

  it("initAutoUpdater wires nothing, sets no feed, and starts no check", async () => {
    const { initAutoUpdater } = await loadUpdater();

    initAutoUpdater();
    // Even after the startup delay and a full scheduler tick have elapsed.
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.on).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("initAutoUpdater still pins electron-updater's dangerous defaults off", async () => {
    const { initAutoUpdater } = await loadUpdater();

    initAutoUpdater();

    // The bug: bailing out before this left autoDownload at its `true`
    // default, so any later checkForUpdates() downloaded silently.
    expect(mocks.autoUpdater.autoDownload).toBe(false);
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("checkForUpdatesManually refuses instead of checking the production feed", async () => {
    const { checkForUpdatesManually } = await loadUpdater();

    await expect(checkForUpdatesManually()).resolves.toEqual({ status: "disabled" });

    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

  it("surfaces the rejection reason to the user rather than a bare 'disabled'", async () => {
    const { checkForUpdatesManually } = await loadUpdater();

    await checkForUpdatesManually();

    const message = mocks.showMessageBox.mock.calls[0]?.[0]?.message ?? "";
    expect(message).toContain(UPDATE_FEED_URL_ENV);
    expect(message).toContain("https:");
  });

  it("refuses after initAutoUpdater has already run, not just standalone", async () => {
    const { initAutoUpdater, checkForUpdatesManually } = await loadUpdater();

    initAutoUpdater();
    await checkForUpdatesManually();
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe("no opt-in", () => {
  it("touches the updater singleton not at all", async () => {
    const { initAutoUpdater } = await loadUpdater();

    initAutoUpdater();
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(mocks.autoUpdater.on).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("reports disabled from a manual check", async () => {
    const { checkForUpdatesManually } = await loadUpdater();

    await expect(checkForUpdatesManually()).resolves.toEqual({ status: "disabled" });
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("is disabled when unpackaged even with the opt-in set", async () => {
    mocks.app.isPackaged = false;
    process.env[AUTO_UPDATE_OPT_IN_ENV] = "1";
    const { initAutoUpdater, checkForUpdatesManually } = await loadUpdater();

    initAutoUpdater();
    await expect(checkForUpdatesManually()).resolves.toEqual({ status: "disabled" });
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(mocks.autoUpdater.on).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe("packaged, opted in, feed accepted", () => {
  it("wires handlers, disables auto-download, and applies an https feed override", async () => {
    process.env[AUTO_UPDATE_OPT_IN_ENV] = "1";
    process.env[UPDATE_FEED_URL_ENV] = "https://updates.example.com/geode/";
    const { initAutoUpdater } = await loadUpdater();

    initAutoUpdater();

    expect(mocks.autoUpdater.autoDownload).toBe(false);
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://updates.example.com/geode/",
    });
    const wired = mocks.autoUpdater.on.mock.calls.map((c) => c[0]);
    expect(wired).toEqual(
      expect.arrayContaining([
        "update-available",
        "update-not-available",
        "download-progress",
        "update-downloaded",
        "error",
      ])
    );
  });

  it("leaves the baked-in feed alone when no override is set", async () => {
    process.env[AUTO_UPDATE_OPT_IN_ENV] = "true";
    const { initAutoUpdater } = await loadUpdater();

    initAutoUpdater();

    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.on).toHaveBeenCalled();
  });

  it("lets a manual check through", async () => {
    process.env[AUTO_UPDATE_OPT_IN_ENV] = "1";
    const { checkForUpdatesManually } = await loadUpdater();

    await expect(checkForUpdatesManually()).resolves.toEqual({ status: "checking" });
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});
