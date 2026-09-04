# ADR 0003 — Auto-update mechanism

**Status:** Accepted (MVP scope). **Feature gated OFF by default — see
"Amendment 2026-09-04" below.**
**Date:** 2026-08-14 (amended 2026-09-04)
**Compass:** Roadmap item `d36470c9` — "Mobile (Capacitor) + packaging/auto-update, pop-out windows, splits" (this ADR advances the packaging/auto-update part of that item).

---

## Amendment (2026-09-04) — opt-in gate + HTTPS-only feed

The version of this ADR accepted on 2026-08-14 named the `error`-event
fallback dialog ("Open Releases Page") as **the mitigation** for the
unverified `quitAndInstall()` ad-hoc-signing risk. In the shipped code that
mitigation was unreachable: the dialog is gated on `manualCheckInFlight`,
which only `checkForUpdatesManually()` sets, and nothing triggers a manual
check — `window.geode.checkForUpdates` has no renderer callers, there is no
"Check for Updates" menu item in `src/main/application-menu.ts`, and the
`updater-progress` event has no listeners. A background check that failed
mid-install would therefore have been silent to the user, which is exactly
the outcome the mitigation existed to prevent.

Because the mitigation is not actually in force, the feature is now **off by
default**, and two guards were added:

1. **Explicit opt-in.** `initAutoUpdater()` requires `app.isPackaged` **and**
   the `GEODE_ENABLE_AUTO_UPDATE` environment variable set to an affirmative
   value (`1`/`true`/`yes`/`on`, case-insensitive). Anything else — including
   a normal packaged build with the variable unset — logs one line saying it
   is off and why, and starts no timers, shows no dialogs, and makes no
   network calls. `checkForUpdatesManually()` honours the same gate and
   returns `{status: "disabled"}` with an explanatory dialog.
2. **HTTPS-only custom feed.** `GEODE_UPDATE_FEED_URL` is validated before it
   reaches `setFeedURL({provider: "generic", url})`. A non-`https:` scheme or
   an unparseable value is **rejected and the updater does not initialise at
   all** (fail closed — silently falling back to the production feed would
   hide an operator's mis-set override). These builds have no publisher
   identity to verify against, so a plaintext `http://` feed would let anyone
   on the network path hand the app an "update" to install.

Both decisions live in a new pure module `src/main/update-config.ts`
(`resolveAutoUpdateGate`, `resolveUpdateFeedUrl`, `isTruthyFlag`) — no
Electron imports, mirroring the `update-scheduler.ts` split — and are covered
by `tests/unit/update-config.test.ts`.

**The gate comes off when, and only when, the packaged update path has
actually been exercised end to end:** two ad-hoc-signed `electron-builder
--mac` builds, a real feed, `update-downloaded` → "Restart Now" →
`quitAndInstall()`, plus a confirmed recovery path when that install fails
(the error dialog reachable from something a user can actually click). Until
then this feature is dormant in every shipped build. **As of 2026-09-04 that
verification has NOT been done.**

A follow-on change should also wire the manual check to a real "Check for
Updates…" menu item, so the documented fallback is reachable by a user rather
than only by an IPC call nothing makes.

---

## Context

Geode is distributed today as a `dmg`/`zip` built by `electron-builder`
(`package.json` `build.mac`, `build.publish: {provider: "github", owner:
"rbcodelabs", repo: "geode", releaseType: "release"}`). GitHub Releases
already receive the correct artifact shape for `electron-updater` — a
`latest-mac.yml` manifest alongside the `.dmg`/`.zip` and blockmaps — so no
publish-config changes were needed to support auto-update; only the update
*client* was missing.

Every install today is static: a user who downloaded v0.2.x has no
in-app path to v0.2.(x+1) short of re-downloading and re-installing by hand
from the GitHub Releases page. That's an acceptable MVP posture but not a
sustainable one as release cadence increases.

### Locked-in constraints (not up for relitigation)

1. **macOS only.** `package.json` `build` config defines no `win`/`linux`
   target blocks — there is nothing to auto-update on those platforms
   because Geode isn't built for them at all. This ADR does not change that.
2. **User-confirmed, never silent or forced.** Consistent with Geode's
   local-first, no-phone-home posture (ADR 0001, ADR 0002): a download
   never starts and an install never happens without an explicit click.
3. **No code-signing/notarization work.** `build.mac.identity` is `"-"`
   (ad-hoc signing), `hardenedRuntime: false`. Real Developer ID signing +
   notarization is a separate, larger effort (Apple developer account,
   CI secrets, notarization turnaround) explicitly deferred — see
   "Non-goals" below.

## Decision

Wrap `electron-updater`'s singleton `autoUpdater` (`src/main/auto-updater.ts`)
with `autoDownload = false` and a manual-vs-background distinction on every
event: a background check that finds nothing stays silent, but a
user-triggered "check now" (or any download/install prompt) always shows a
dialog. Every dialog fires through `dialog.showMessageBox`, so there's a
single code path to audit for "does this ever act without a click."

The feed URL is resolved by `electron-updater`'s baked-in
`app-update.yml` (which points at the GitHub Releases publish config)
unless the `GEODE_UPDATE_FEED_URL` environment variable is set, in which
case a generic feed is used instead — the same override precedent already
established by `GEODE_GITHUB_API_BASE`/`GEODE_GITHUB_RAW_BASE` (ADR 0001)
and `GEODE_POLICY_PATH` (ADR 0002): production uses the real default, tests
and local verification point at a fake/local target.

### The ad-hoc-signing risk on `quitAndInstall()`

`hardenedRuntime: false` + `identity: "-"` was previously fixed
(see git history: "macOS ad-hoc signing fixed") to solve **Gatekeeper
launch validation** — the OS-level quarantine check that runs the first
time a user opens a freshly-downloaded `.app`. That fix does not solve a
different problem: **Squirrel.Mac's self-replace signature check inside
`autoUpdater.quitAndInstall()`**.

These are not the same gate:

- **Gatekeeper (solved):** runs once, on first launch of a downloaded app,
  checks the quarantine xattr + code signature against Apple's policy for
  *opening* an app a user downloaded.
- **Squirrel.Mac (open risk, not solved by this ADR):** runs every time
  `quitAndInstall()` swaps the running `.app` bundle for the newly
  downloaded one. Squirrel.Mac compares the code signature of the *old*
  binary against the *new* one before it will perform the swap — an
  ad-hoc signature (`identity: "-"`) is not guaranteed to produce a stable,
  comparable identity across builds the way a real Developer ID
  certificate does. Whether this actually fails is only knowable by
  exercising the real `quitAndInstall()` path against two ad-hoc-signed
  builds, which is exactly what this ADR's verification step (below) does.

Because this is a real, not-yet-proven-safe risk, the fallback dialog on
`autoUpdater`'s `error` event (`"Open Releases Page"` → `shell.openExternal`
to the GitHub Releases page) is treated as **the permanent safety net for
this feature**, not a temporary stopgap to delete once the happy path is
confirmed. Even if `quitAndInstall()` is later found to work reliably, a
network blip, a corrupted download, or a future signing regression should
still degrade to "go get it yourself" rather than a silent failure.

## Scope

**In scope (MVP):**
- Background update checks on a schedule (startup + 6h cadence,
  `src/main/update-scheduler.ts`), only while the app is packaged.
- Manual "check for updates now" trigger via IPC
  (`checkForUpdatesManually()` in `src/main/auto-updater.ts`,
  `updater-check` IPC handler, `geode.checkForUpdates()` in preload).
- User-confirmed download (`update-available` dialog → "Download Update").
- User-confirmed install (`update-downloaded` dialog → "Restart Now" →
  `quitAndInstall()`).
- A download-progress event forwarded to the renderer
  (`updater-progress` IPC event) as a stub for future UI — no UI consumes
  it yet.
- A hard fallback on any updater error: "Open Releases Page" dialog that
  actually opens the browser, so a failure never leaves the user stuck.

**Non-goals (deferred, explicitly out of scope for this pass):**
- **Windows/Linux support.** No build targets exist for either platform;
  adding auto-update for them is meaningless until packaging exists.
- **Silent or forced updates.** Every state transition requires a click.
  This is a permanent design constraint, not an MVP limitation to relax
  later.
- **Developer ID signing / notarization.** A real fix for the
  `quitAndInstall()` risk almost certainly requires this, but it's a
  separate effort (Apple Developer Program enrollment, CI secret
  management, notarization pipeline) tracked as follow-up work under the
  same Compass roadmap item, not bundled into this ADR.
- **Settings-panel toggle UI.** There's no way yet for a user to disable
  background checks or change the interval from Settings. The only manual
  control is the (as yet unwired to UI) `checkForUpdatesManually()` call
  and its IPC/preload plumbing — a future ADR/PR wires an actual button.

## Design

### Files

```
src/main/
  update-scheduler.ts   # NEW — pure "is it time to check yet?" logic, no Electron imports
  update-config.ts       # NEW (2026-09-04) — pure opt-in gate + HTTPS-only feed-URL validation
  auto-updater.ts        # NEW — electron-updater wiring: init, manual check, event handlers
  main.ts                 # MODIFIED — calls initAutoUpdater() after createWindow();
                           #   registers the "updater-check" IPC handler
  preload.ts               # MODIFIED — exposes geode.checkForUpdates()
```

### `update-scheduler.ts` — pure scheduling logic

```ts
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function shouldCheckForUpdates(
  lastCheckedAt: number | null,
  now: number,
  intervalMs = DEFAULT_UPDATE_CHECK_INTERVAL_MS
): boolean;
```

- `lastCheckedAt === null` (never checked) → `true`.
- `now < lastCheckedAt` (clock skew) → `false` — deliberately conservative;
  a backwards clock jump should not trigger a check storm.
- Otherwise → `now - lastCheckedAt >= intervalMs` (inclusive boundary).

No Electron imports, matching the `github-resolve.ts`/`policy.ts` precedent
of keeping decision logic independently unit-testable
(`tests/unit/update-scheduler.test.ts`).

### `auto-updater.ts` — electron-updater wiring

- `initAutoUpdater()`: no-op (with a log line) unless
  `resolveAutoUpdateGate(process.env, app.isPackaged)` returns enabled —
  i.e. packaged **and** `GEODE_ENABLE_AUTO_UPDATE` explicitly set (see the
  2026-09-04 amendment). The Playwright e2e smoke test launches Electron from
  source, so this must never touch the network, show a dialog, or start a
  timer in that mode. When enabled: optional `GEODE_UPDATE_FEED_URL` override,
  HTTPS-validated by `resolveUpdateFeedUrl`, via
  `autoUpdater.setFeedURL({provider: "generic", url})`; `autoDownload =
  false`; wires all event handlers; schedules a first check 5s after
  ready, then re-evaluates every 30 minutes via `shouldCheckForUpdates`
  against the 6h default interval.
- `checkForUpdatesManually()`: dev mode shows an "updates disabled in
  development" dialog and returns immediately; packaged mode marks the
  in-flight check as manual (so `update-not-available`/`error` show a
  dialog instead of staying silent) and calls `autoUpdater.checkForUpdates()`.
- Event handlers, always resolving the target window as
  `BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ??
  undefined` (a window-less `dialog.showMessageBox` call is valid and
  still shows a system-level dialog):
  - `update-available` → `["Download Update", "Later"]`; "Download
    Update" → `autoUpdater.downloadUpdate()`.
  - `update-not-available` → dialog only if the in-flight check was
    manual; silent for background checks.
  - `download-progress` → `webContents.send("updater-progress", {percent})`
    to the active window, no dialog.
  - `update-downloaded` → `["Restart Now", "Later"]`; "Restart Now" →
    `autoUpdater.quitAndInstall()`.
  - `error` → always `console.error`; on a manual check only, dialog with
    `["Open Releases Page", "Dismiss"]` → `shell.openExternal` to
    `https://github.com/rbcodelabs/geode/releases/latest`.

### Wiring

`main.ts`: `initAutoUpdater()` called after `createWindow()` inside
`app.whenReady().then(...)`. `ipcMain.handle("updater-check", () =>
checkForUpdatesManually())` registered inside `registerIpc()`, grouped
near the other feature handlers (community install, chrome cookies).

`preload.ts`: `checkForUpdates: (): Promise<UpdaterCheckResult> =>
ipcRenderer.invoke("updater-check")` added to the exposed `api` object,
matching the existing style exactly. `UpdaterCheckResult = { status:
"checking" | "disabled" }`.

## Failure modes

| Condition | Behavior |
|---|---|
| Packaged, `GEODE_ENABLE_AUTO_UPDATE` unset (**the default**) | `initAutoUpdater()` no-ops with a log line; `checkForUpdatesManually()` returns `disabled` with an explanatory dialog. No timers, no network, no dialogs. |
| `GEODE_UPDATE_FEED_URL` set to a non-`https:` or unparseable value | `initAutoUpdater()` logs an error and returns — the updater does not initialise at all rather than silently using the production feed. |
| Unpackaged (dev/e2e) | `initAutoUpdater()` no-ops; `checkForUpdatesManually()` shows a "disabled in development" dialog and never touches the network. |
| Background check finds no update | Silent — `lastCheckedAt` updates, nothing shown. |
| Background check errors (offline, rate-limited, malformed feed) | `console.error` only — no dialog, so a flaky background check never interrupts the user. |
| Manual check finds no update | "You're up to date" dialog. |
| Manual check errors | "Open Releases Page" fallback dialog — the permanent safety net described above. |
| `quitAndInstall()` fails the Squirrel.Mac signature check | Not directly observable as a distinct event from `electron-updater`'s public API in this design; a hung/failed install surfaces as either an `error` event (if it fires before the app quits) or the app simply not relaunching. The fallback dialog on `error` is the mitigation; the real-world behavior of this exact path is documented in this ADR's verification section, not assumed. |
| Clock skew (system clock moved backwards) | `shouldCheckForUpdates` returns `false` until real time catches back up past the last recorded check. |

## Test plan

Matches the repo's standard three-tier gate (`typecheck`, `test:unit` →
`vitest run`, `test:e2e` → `build` + `playwright test`).

- **`tests/unit/update-config.test.ts`** — opt-in absent ⇒ gated off (with a
  reason naming the env var); non-affirmative values ⇒ off; unpackaged ⇒ off
  even when opted in; packaged + affirmative ⇒ on. Feed URL: unset/blank ⇒
  default feed; `https://…` ⇒ accepted; `http://`, `file://`, `ftp://`,
  `javascript:`, `data:` and unparseable garbage ⇒ rejected.
- **`tests/unit/update-scheduler.test.ts`** — never-checked ⇒ true;
  exactly-at-boundary ⇒ true (inclusive); short-of-interval ⇒ false;
  clock-skew ⇒ false; custom interval override.
- **E2E:** no new Playwright spec — `initAutoUpdater()`'s dev no-op is
  implicitly covered by every existing e2e spec staying green (any
  network call, dialog, or thrown error in dev mode would surface as a
  console error or a hung test). A dedicated packaged-app update-flow
  test is impractical in CI (requires two full `electron-builder --mac`
  builds and a local file server) and was instead run manually as a
  one-off verification pass — see this PR's description/report for the
  observed result, not encoded as an automated test.

## Consequences

- **What becomes easier:** users on a stale build can get to the latest
  release without leaving the app, closing the gap between "GitHub
  Release exists" and "users actually run it."
- **What becomes harder:** every release now needs `latest-mac.yml` +
  correctly-shaped `.zip`/blockmap artifacts attached — already true of
  the existing `electron-builder --publish` flow, but now a *load-bearing*
  requirement rather than an unused nicety.
- **What we're betting on:** that the ad-hoc-signing risk on
  `quitAndInstall()` either turns out to be a non-issue in practice, or
  that the fallback dialog is an acceptable permanent UX for the subset of
  users who hit it, until real code-signing work is scheduled.
- **What would make me revise this:** a verification run showing
  `quitAndInstall()` reliably fails the Squirrel.Mac signature check would
  argue for either fast-tracking Developer ID signing/notarization, or
  reframing the feature as "notify + link to release page" only
  (dropping in-app download/install entirely) rather than shipping a
  download/install path that never actually completes.
