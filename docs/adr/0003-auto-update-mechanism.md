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
   an unparseable value is **rejected, and the feature stays inert** (fail
   closed — silently falling back to the production feed would hide an
   operator's mis-set override). These builds have no publisher identity to
   verify against, so a plaintext `http://` feed would let anyone on the
   network path hand the app an "update" to install.

   Concretely, on a rejected feed: `initAutoUpdater()` logs an error, wires no
   handlers, sets no feed and starts no timers, **and pins
   `autoDownload = false` / `autoInstallOnAppQuit = false`** on the
   electron-updater singleton before returning; `checkForUpdatesManually()`
   returns `{status: "disabled"}` with the reason in a dialog and never calls
   `checkForUpdates()`.

   That last part is not belt-and-braces, it is the fix for a real hole. An
   earlier revision of this amendment claimed "the updater does not initialise
   at all", which was true of `initAutoUpdater()` but **not of the feature**:
   `checkForUpdatesManually()` consulted only the opt-in gate, so a packaged,
   opted-in build with an `http://` feed had `initAutoUpdater()` bail out
   *before* `autoDownload = false` and before any handler was wired, while a
   manual check (`preload.ts` → `updater-check` IPC) sailed through and ran
   `autoUpdater.checkForUpdates()` against the baked-in production
   `app-update.yml`. With electron-updater's defaults — `autoDownload = true`
   and `autoInstallOnAppQuit = true` (`electron-updater/out/AppUpdater.js`) —
   that is a silent download followed by an install on quit, with no dialogs at
   all, because nothing was wired. Exactly the `quitAndInstall()` exposure the
   gate exists to prevent, reached through a door the gate left open.

Both decisions now live behind **one** exported helper,
`resolveUpdaterState(env, isPackaged)`, in the new pure module
`src/main/update-config.ts` (alongside `resolveAutoUpdateGate`,
`resolveUpdateFeedUrl`, `isTruthyFlag`) — no Electron imports, mirroring the
`update-scheduler.ts` split. Both entry points consume that single helper and
nothing else.

Nothing *structurally* prevents them diverging again — `resolveAutoUpdateGate`
and `resolveUpdateFeedUrl` are still exported, and a future caller could reach
for one of them directly. What is true, and is the actual guarantee, is that
such a divergence **fails `tests/unit/auto-updater-wiring.test.ts`**, which
asserts what each entry point does to a mocked `autoUpdater` rather than what
the helpers return. (Stating this precisely matters here: an absolute claim of
the "cannot happen again" kind is what this amendment exists to correct.)
`tests/unit/update-config.test.ts` covers the pure decisions alongside it.

### Amendment (2026-09-04, same day) — `autoInstallOnAppQuit`

`autoDownload = false` alone does not deliver "no install without an explicit
click" on macOS, and the reason is not the mechanism it looks like.
`BaseUpdater.addQuitHandler()` — the obvious suspect — never runs here:
`MacUpdater extends AppUpdater` (`electron-updater/out/MacUpdater.js:13`), not
`BaseUpdater`, and Geode is macOS-only. The live path is
`MacUpdater.js:218-224`:

```js
this.dispatchUpdateDownloaded(event);
if (this.autoInstallOnAppQuit) {
    this.nativeUpdater.once("error", reject);
    this.nativeUpdater.checkForUpdates();   // hands artifact to Squirrel, stages install
}
```

`dispatchUpdateDownloaded()` is what raises our "Restart Now"/"Later" dialog,
and the staging call runs in the **same synchronous block** — before the user
answers. Clicking **"Later" therefore did not decline the install, it deferred
it to the next quit**: an unclicked route into the ad-hoc-signed Squirrel.Mac
self-replace path this entire feature is gated off to keep dormant, and a
direct contradiction of a constraint this ADR calls permanent and
non-relitigable. `initAutoUpdater()` now sets `autoInstallOnAppQuit = false`
on the live path.

Known consequence, accepted: with the flag off,
`MacUpdater.quitAndInstall()` takes its `if (!this.autoInstallOnAppQuit)`
branch (`MacUpdater.js:240-256`), registering a `nativeUpdater`
`update-downloaded` listener and calling `nativeUpdater.checkForUpdates()` to
pull the artifact from the already-running localhost proxy first. Fast, but not
instant — and if that fetch errors, `handleUpdateDownloaded()` never fires and
the app simply never restarts. `manualCheckInFlight` is `false` by then, so
that would have died in `console.error`. `auto-updater.ts` now tracks an
`installRequested` flag between the "Restart Now" click and the outcome, and an
`error` while it is set raises the "Open Releases Page" recovery dialog. The
`nativeUpdater` error does reach us: `MacUpdater`'s constructor wires
`nativeUpdater.on("error", it => this.emit("error", it))`
(`MacUpdater.js:18-21`).

**The gate comes off when, and only when, the packaged update path has
actually been exercised end to end.** Verification checklist:

1. Two ad-hoc-signed `electron-builder --mac` builds and a real feed.
2. `update-available` → "Download Update" → `update-downloaded` fires.
3. **"Later" leaves the app un-updated across a full quit/relaunch cycle** —
   the regression the `autoInstallOnAppQuit` fix exists to prevent.
4. **"Restart Now" → `quitAndInstall()` with `autoInstallOnAppQuit = false`:
   confirm the localhost-proxy fetch succeeds and the app restarts updated;
   confirm a failed fetch surfaces an error rather than a silent no-op.**
5. A recovery path when the install fails — the error dialog, reachable from
   something a user can actually click.

Until all five hold, this feature is dormant in every shipped build. **As of
2026-09-04 that verification has NOT been done.**

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

Both entry points below consult exactly one thing —
`resolveUpdaterState(process.env, app.isPackaged)` — which is live only when
the app is packaged, `GEODE_ENABLE_AUTO_UPDATE` is explicitly set, **and** any
`GEODE_UPDATE_FEED_URL` override passed HTTPS validation. Packaged alone is not
sufficient; that was the pre-fix contract and it was the bug (see the
2026-09-04 amendment).

- `initAutoUpdater()`: when the state is not live, logs one line and returns,
  having started no timers, wired no handlers, set no feed and made no network
  call. If the failure was a rejected feed (so the packaged + opt-in gate had
  already passed and the electron-updater singleton is therefore constructed
  and reachable), it first pins `autoDownload = false` and
  `autoInstallOnAppQuit = false`; when the gate itself failed it does not touch
  the singleton at all, which is what keeps the Playwright e2e launch — running
  from source, `app.isPackaged === false` — free of any network call, dialog or
  timer. When the state IS live: `autoDownload = false`,
  `autoInstallOnAppQuit = false`, an HTTPS-validated `GEODE_UPDATE_FEED_URL`
  override applied via `autoUpdater.setFeedURL({provider: "generic", url})` if
  one was given, all event handlers wired, a first check scheduled 5s after
  ready, then re-evaluated every 30 minutes via `shouldCheckForUpdates` against
  the 6h default interval.
- `checkForUpdatesManually()`: when the state is not live, shows a dialog and
  returns `{status: "disabled"}` **without** calling
  `autoUpdater.checkForUpdates()` — necessarily, since in that state no handlers
  are wired and no feed override was applied, so a check would either go
  nowhere visible or go somewhere wrong. The dialog says "disabled in
  development builds" when unpackaged, and otherwise "turned off in this
  build"; when the specific cause was a rejected feed URL it adds the rejection
  reason as `detail`, because that is an operator misconfiguration and they
  need the specifics. Only when the state is live does it mark the in-flight
  check as manual (so `update-not-available`/`error` show a dialog instead of
  staying silent) and call `autoUpdater.checkForUpdates()`.
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
  - `update-downloaded` → `["Restart Now", "Later"]`; "Restart Now" sets the
    `installRequested` flag, then `autoUpdater.quitAndInstall()`. "Later"
    genuinely declines (see the `autoInstallOnAppQuit` amendment).
  - `error` → always `console.error`; a dialog with
    `["Open Releases Page", "Dismiss"]` → `shell.openExternal` to
    `https://github.com/rbcodelabs/geode/releases/latest` when EITHER the
    in-flight check was manual OR `installRequested` is set. The second case
    covers a `quitAndInstall()` that fails its localhost-proxy fetch: the user
    clicked a button and nothing happened, which must not be silent. A
    background-check error remains silent.

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
| `GEODE_UPDATE_FEED_URL` set to a non-`https:` or unparseable value | Both entry points refuse. `initAutoUpdater()` logs an error, pins `autoDownload = false` and `autoInstallOnAppQuit = false` on the electron-updater singleton, wires no handlers, sets no feed, and starts no timers; `checkForUpdatesManually()` returns `{status: "disabled"}` with the rejection reason in a dialog and never calls `checkForUpdates()`. Nothing falls back to the production feed. |
| Unpackaged (dev/e2e) | `initAutoUpdater()` no-ops; `checkForUpdatesManually()` shows a "disabled in development" dialog and never touches the network. |
| Background check finds no update | Silent — `lastCheckedAt` updates, nothing shown. |
| Background check errors (offline, rate-limited, malformed feed) | `console.error` only — no dialog, so a flaky background check never interrupts the user. |
| Manual check finds no update | "You're up to date" dialog. |
| Manual check errors | "Open Releases Page" fallback dialog — the permanent safety net described above. |
| User clicks "Later" on `update-downloaded` | The install is genuinely declined. `autoInstallOnAppQuit = false`, so nothing is staged for the next quit. |
| `quitAndInstall()`'s localhost-proxy fetch fails after "Restart Now" | `MacUpdater`'s constructor re-emits `nativeUpdater` errors as our `error` event; `installRequested` is set, so the "Open Releases Page" dialog fires. The click never silently does nothing. |
| `quitAndInstall()` fails the Squirrel.Mac signature check | Not directly observable as a distinct event from `electron-updater`'s public API in this design; a hung/failed install surfaces as either an `error` event (if it fires before the app quits) or the app simply not relaunching. The `error`-plus-`installRequested` dialog above is the mitigation for the observable case; the real-world behavior of this exact path is documented in this ADR's verification checklist, not assumed. |
| Clock skew (system clock moved backwards) | `shouldCheckForUpdates` returns `false` until real time catches back up past the last recorded check. |

## Test plan

Matches the repo's standard three-tier gate (`typecheck`, `test:unit` →
`vitest run`, `test:e2e` → `build` + `playwright test`).

- **`tests/unit/update-config.test.ts`** — opt-in absent ⇒ gated off (with a
  reason naming the env var); non-affirmative values ⇒ off; unpackaged ⇒ off
  even when opted in; packaged + affirmative ⇒ on. Feed URL: unset/blank ⇒
  default feed; `https://…` ⇒ accepted; `http://`, `file://`, `ftp://`,
  `javascript:`, `data:` and unparseable garbage ⇒ rejected. Plus
  `resolveUpdaterState` combining both, including the `gatePassed` distinction
  that decides whether the singleton may be touched at all.
- **`tests/unit/auto-updater-wiring.test.ts`** — the seam the pure tests
  cannot reach, with `electron`/`electron-updater` mocked. On a rejected feed
  with the opt-in set: `setFeedURL` not called, no handlers wired,
  `checkForUpdates` not called from **either** entry point (before or after
  `initAutoUpdater()` has run), `autoDownload`/`autoInstallOnAppQuit` both
  pinned `false`, and the dialog names the offending env var. On the live
  path: handlers wired, `autoDownload` AND `autoInstallOnAppQuit` both `false`
  (the second is what stops "Later" staging an install), feed override applied,
  and — the positive counterpart to all the "not called" assertions — a check
  actually fires at `STARTUP_CHECK_DELAY_MS` and not before. Plus: an `error`
  after an explicit "Restart Now" raises the recovery dialog, while a
  background-check `error` stays silent; and the no-opt-in dialog does not leak
  the internal gate reason to an end user.
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
