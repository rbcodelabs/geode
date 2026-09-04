/**
 * Pure configuration/validation logic for the auto-updater — no Electron
 * imports, so it is unit-testable without launching an app (the same split as
 * `update-scheduler.ts`; see docs/adr/0003-auto-update-mechanism.md).
 *
 * Two decisions live here:
 *
 *  1. **Is auto-update allowed to run at all?** It is OFF by default, even in
 *     a packaged build, and stays off until someone explicitly opts in. ADR
 *     0003 documents an open, unverified risk: `quitAndInstall()` between two
 *     ad-hoc-signed builds (`build.mac.identity: "-"`,
 *     `hardenedRuntime: false`) may fail Squirrel.Mac's self-replace signature
 *     check, and the documented mitigation — the "Open Releases Page" fallback
 *     dialog — only fires for a MANUAL check, which no menu item or renderer
 *     caller triggers. Until the packaged update/recovery path has actually
 *     been exercised, shipping this live would mean shipping a download/install
 *     path whose failure mode is invisible.
 *
 *  2. **Is a custom feed URL safe to use?** `GEODE_UPDATE_FEED_URL` is handed
 *     straight to `setFeedURL({provider: "generic", url})`. These builds carry
 *     no publisher-identity check, so a plaintext `http://` feed would let
 *     anything on the network path hand the app an "update" to install.
 *     HTTPS only.
 */

/** Env var that must be explicitly set for auto-update to run in a packaged build. */
export const AUTO_UPDATE_OPT_IN_ENV = "GEODE_ENABLE_AUTO_UPDATE";
/** Env var that overrides the baked-in `app-update.yml` feed. HTTPS only. */
export const UPDATE_FEED_URL_ENV = "GEODE_UPDATE_FEED_URL";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Whether an env-var string reads as an explicit "yes". Unset/empty ⇒ false. */
export function isTruthyFlag(raw: string | undefined): boolean {
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

export type AutoUpdateGate =
  | { enabled: true }
  | { enabled: false; reason: string };

/**
 * Decide whether `initAutoUpdater()` should do anything. Both conditions must
 * hold: the app is packaged AND the operator explicitly opted in. Default OFF.
 */
export function resolveAutoUpdateGate(
  env: Record<string, string | undefined>,
  isPackaged: boolean
): AutoUpdateGate {
  if (!isPackaged) {
    return { enabled: false, reason: "app is not packaged (app.isPackaged === false)" };
  }
  if (!isTruthyFlag(env[AUTO_UPDATE_OPT_IN_ENV])) {
    return {
      enabled: false,
      reason:
        `${AUTO_UPDATE_OPT_IN_ENV} is not set — auto-update stays off by default until the ` +
        "packaged update/recovery path has been verified on an ad-hoc-signed build " +
        "(docs/adr/0003-auto-update-mechanism.md)",
    };
  }
  return { enabled: true };
}

export type UpdateFeedUrl =
  /** No override — use electron-updater's baked-in `app-update.yml`. */
  | { kind: "default" }
  | { kind: "custom"; url: string }
  | { kind: "invalid"; raw: string; reason: string };

/**
 * Validate the `GEODE_UPDATE_FEED_URL` override. Unset/blank means "use the
 * default feed". Anything present must parse as a URL and must be `https:` —
 * an unparseable or non-HTTPS value is rejected rather than quietly falling
 * back, so a mis-set feed can never be mistaken for the real one.
 */
export function resolveUpdateFeedUrl(raw: string | undefined): UpdateFeedUrl {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return { kind: "default" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { kind: "invalid", raw: trimmed, reason: "not a parseable URL" };
  }
  if (parsed.protocol !== "https:") {
    return {
      kind: "invalid",
      raw: trimmed,
      reason: `must use https: (got "${parsed.protocol}") — these builds have no publisher-identity check to fall back on`,
    };
  }
  return { kind: "custom", url: trimmed };
}

export type UpdaterState =
  | { live: true; feed: { kind: "default" } | { kind: "custom"; url: string } }
  | {
      live: false;
      /**
       * True when the packaged + opt-in gate PASSED and only the feed URL was
       * rejected. In that state electron-updater's singleton is fair game in
       * this process, so its dangerous defaults (`autoDownload = true`,
       * `autoInstallOnAppQuit = true`) must be pinned off before bailing out.
       * False means we never got past the gate and must not touch it at all
       * (touching it unpackaged is exactly what the dev/e2e no-op avoids).
       */
      gatePassed: boolean;
      reason: string;
    };

/**
 * THE single "should the updater be doing anything, and against which feed?"
 * decision. Both entry points in `auto-updater.ts` — `initAutoUpdater()` and
 * `checkForUpdatesManually()` — must consume this and nothing else.
 *
 * They previously consulted different subsets: `initAutoUpdater()` checked the
 * gate AND the feed, while `checkForUpdatesManually()` checked only the gate.
 * A packaged, opted-in build with a rejected `http://` feed therefore left
 * `initAutoUpdater()` bailing out early — before `autoDownload = false` and
 * before any event handler was wired — while a manual check sailed through and
 * called `autoUpdater.checkForUpdates()` with no feed override at all,
 * resolving the baked-in production `app-update.yml`. With electron-updater's
 * defaults (`autoDownload = true`, `autoInstallOnAppQuit = true`) that is a
 * silent download and an install on quit, with no dialogs, because nothing was
 * wired. Keeping the decision in one function is what stops the two entry
 * points drifting apart again.
 */
export function resolveUpdaterState(
  env: Record<string, string | undefined>,
  isPackaged: boolean
): UpdaterState {
  const gate = resolveAutoUpdateGate(env, isPackaged);
  if (!gate.enabled) return { live: false, gatePassed: false, reason: gate.reason };

  const feed = resolveUpdateFeedUrl(env[UPDATE_FEED_URL_ENV]);
  if (feed.kind === "invalid") {
    return {
      live: false,
      gatePassed: true,
      reason: `${UPDATE_FEED_URL_ENV}="${feed.raw}" rejected: ${feed.reason}`,
    };
  }
  return { live: true, feed };
}
