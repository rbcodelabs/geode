/**
 * Pure configuration/validation logic for the auto-updater — no Electron
 * imports, so it is unit-testable without launching an app (the same split as
 * `update-scheduler.ts`; see docs/adr/0003-auto-update-mechanism.md).
 *
 * Two decisions live here:
 *
 *  1. **Is this a packaged build?** Signed production packages update by
 *     default. Development and E2E builds remain inert.
 *
 *  2. **Is a custom feed URL safe to use?** `GEODE_UPDATE_FEED_URL` is handed
 *     straight to `setFeedURL({provider: "generic", url})`. Developer ID is
 *     the final publisher boundary, but update discovery and metadata must
 *     still be protected from transport tampering. HTTPS only.
 */

/** Env var that overrides the baked-in `app-update.yml` feed. HTTPS only. */
export const UPDATE_FEED_URL_ENV = "GEODE_UPDATE_FEED_URL";

export type AutoUpdateGate =
  | { enabled: true }
  | { enabled: false; reason: string };

/**
 * Decide whether `initAutoUpdater()` should do anything. Signed packaged
 * builds are live by default; unpackaged builds never touch electron-updater.
 */
export function resolveAutoUpdateGate(
  _env: Record<string, string | undefined>,
  isPackaged: boolean
): AutoUpdateGate {
  if (!isPackaged) {
    return { enabled: false, reason: "app is not packaged (app.isPackaged === false)" };
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
      reason: `must use https: (got "${parsed.protocol}") to protect update metadata in transit`,
    };
  }
  return { kind: "custom", url: trimmed };
}

export type UpdaterState =
  | { live: true; feed: { kind: "default" } | { kind: "custom"; url: string } }
  | {
      live: false;
      /**
       * True when the packaged-build gate passed and only the feed URL was
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
 * A packaged build with a rejected `http://` feed therefore left
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
