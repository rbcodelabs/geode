# Mobile plugin host contract (Threads + Google Docs Sync)

**Status:** Implemented. Extends [Slice 3A](mobile-mvp-slice-3a-plugin-runtime-spec.md) and
[ADR-0009](../adr/0009-mobile-plugin-esm-preflight.md) with the host services real plugins
needed once they ran on a phone: Agent Threads (`claude-threads`) and Google Docs Sync
(`obsidian-gdocs-sync`). Both were probed against the real shipped bundles: Google Docs Sync
loaded as soon as its manifest declared mobile support; the 19.8 MB Node-targeted Agent
Threads bundle was (correctly) rejected by the 16 MiB mobile entrypoint cap.

## What a mobile plugin gets

| Need | Contract |
|---|---|
| Know it is on mobile | `Platform.isMobile`, `isMobileApp`, `isPhone`/`isTablet` are true and `isDesktop`/`isDesktopApp` false, resolved from `<body class="is-mobile">` (desktop unchanged). `isIosApp` is true on the Capacitor shell. |
| A browser-only bundle | A plugin may ship `main.mobile.js` beside `main.js`. Mobile reads `main.mobile.js` first and falls back to `main.js` **only** when the mobile file does not exist (not-found codes); any other failure surfaces, so a broken or oversized mobile bundle can never silently load the Node/Electron bundle. Desktop never reads it. Obsidian ignores it. |
| Update safety | `PluginFileSet.entry` (`main.js` \| `main.mobile.js`) tells the host which file a rollback restores; the last known-good mobile bundle is kept on a failed update. |
| Secrets | `loadSecret/saveSecret/removeSecret` work on mobile: iOS Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`), namespaced by plugin id. A plugin only receives an opaque per-session capability minted with its entrypoint read; it cannot address another plugin's namespace. The plain browser host keeps secrets **unavailable**. |
| OAuth return | `geode://<action>?…` links (the `obsidian://` alias too) reach `registerObsidianProtocolHandler(action, …)`. Native forwards them with `retainUntilConsumed`, and the app buffers links that arrive before a handler registers. `Info.plist` registers the `geode` scheme. |
| Network | `requestUrl` and plugin `fetch()` go through a native `URLSession` bridge (`host.network`): http(s) only, 30 s default / 120 s max timeout, 32 MiB response cap, cancellable. The shell CSP (`default-src 'self'`) otherwise blocks every plugin request (found when the real Google Docs Sync bundle was loaded). |
| WebSocket | The mobile CSP adds `connect-src 'self' wss:` so the Threads relay client can connect; no other direct network origin is allowed. |
| Open a web page | `window.open(http(s) url)` is routed to the system browser (`UIApplication.open`); other schemes are refused. |

Unchanged limits: no Node/Electron modules, ESM preflight, 16 MiB entrypoint cap, admission
labels, quarantine.

## Plugin-side obligations

- **Google Docs Sync** (`isDesktopOnly: false`): opens its OAuth start URL with
  `window.open` when Electron is absent; callback returns as `geode://gdocs-sync`.
  Tokens go to the Keychain via `saveSecret`; without it full-vault sync stays blocked.
- **Agent Threads**: ships a small `main.mobile.js` containing only the relay client,
  mobile thread view and `pair` handler. Execution stays on the paired desktop
  (ADR-0008, Option A). The room-id relay is still the prototype transport ADR-0008 says
  must be hardened; mobile stores the room id in secure storage and the UI says so.

## Verification

- Unit: `tests/unit/host/mobile-plugin-host.test.ts` (secret isolation, capacity limits,
  Capacitor bridge routing, deep-link parsing/forwarding, `window.open`).
- Real mobile Chromium (phone + tablet): `tests/mobile/mobile-renderer.spec.ts`
  "mobile plugins use main.mobile.js…" — an OAuth-shaped fixture proves desktop entry never
  read, Platform flags, system-browser open, forged-state rejection, Keychain storage with
  cross-plugin isolation, early deep-link replay, and mobile-entry update rollback.
- Swift compiles for the iOS Simulator (`xcodebuild … build`); Keychain, `openExternal`
  and scheme delivery have **not** been exercised on a simulator or device. That, plus
  physical-device Keychain/data-protection validation, remains a release-candidate gate.
