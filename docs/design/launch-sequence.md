# Launch sequence

While a vault opens, Geode runs an ordered list of steps behind a launch screen
(the first-run vault-picker look: gem chip, "Geode" lockup, same typography)
with live per-step status, a progress bar, and a Skip button for the running
step when it is optional.

Code: `src/renderer/launch/launch-sequence.ts` (pure registry + runner, unit
tested) and `launch-overlay.ts` (DOM). Wiring is in `App.openVaultMeasured`.

## Vault Hub: the picker and the launch screen are one surface

`src/renderer/vault-hub.ts` is the full-window vault screen. It replaces both the
first-run picker and the old "Manage vaults" modal, and it shares the
`.vault-picker` surface with this launch screen. Pure helpers (avatar color,
ordering, arrow-key navigation) live in `vault-hub-model.ts` and are unit tested.

- **Cards.** One per vault in the registry's recency order, the vault open in
  this window first (tagged "Open in this window"). Avatar and color are derived
  from the name. There is no last-opened time, note count or sync state: the
  registry does not provide them, so the hub does not invent them. The hover "..."
  menu offers "Open in new window" (desktop, not for the current vault) and
  "Remove from list" (hosts that implement `removeRecentVault`, i.e. Electron).
  There is no "Reveal in Finder": the host can only reveal a path inside the open vault.
- **Dashed cards.** "Create new vault" (Electron, `createVaultSupport`), "Open
  folder as vault", "Choose folder in Files" (hosts with `externalVaultFolder`
  other than desktop, where it is the same dialog), and on first run "Try the sample
  vault". iOS shows "On this device" / "Choose folder in Files" and the
  "On this device" / "Files folder" descriptors via `describeVault`.
- **Morph.** Choosing a card fades the others out and expands the chosen card in
  place (FLIP on its position and width) into the launch panel. If a first-run open
  is in flight, `setupLaunchSequence` hands the `LaunchRunner` to the hub
  (`VaultHub.bindLaunch`) instead of creating a `LaunchOverlay`, so the card shows
  the same snapshot, step list and Skip button; `finishLaunchSequence` fades the hub
  out. Before the runner exists the card shows an indeterminate bar. Launch logic is
  unchanged: the hub only reads snapshots. Opening in a new window (desktop) or an
  in-window switch (iOS/browser, which reloads) morphs the card and then closes the
  hub or waits for the reload. A failed open undoes the morph and shows the error;
  `VaultAccessError` keeps its Reconnect prompt.
- **Reduced motion.** Under `prefers-reduced-motion: reduce` nothing slides or
  scales: the siblings and the panel only fade.
- **Keyboard and focus.** Arrow keys, Home and End move between cards, Esc or the
  close button dismisses it (not on first run), Tab is trapped, focus returns to the
  previously focused element, and the workspace's command hotkeys are gated while
  it is open. Right-click, the Menu key or Shift+F10 open a card's menu.
- **Theme.** The hub carries the picker palette (light and dark). Only the first-run
  hub follows the OS appearance; over a workspace it keeps the vault's theme.

## Why

Auto-updates used to run ~2.5s after launch and hot-reloaded plugins that were
already running, which killed live Agent Threads conversations. Updates now run
before any plugin is loaded, so an update is a plain on-disk install.

## Phases

| Phase | Who registers | When it runs |
|---|---|---|
| `before-plugins` | Built-in code only | Before `PluginManager.initialize()` |
| `after-plugins` | Plugins, in `onload()` | Right after `initialize()`; the screen stays up until they finish |

Built-in step `core:community-updates` ("Checking plugin updates", optional,
15s cap) calls `CommunityManager.checkForUpdates({ reload: false, signal })`,
so `pluginManager.reload` is never called at launch. It is skipped under
`GEODE_HEADLESS`/e2e. The 2.5s post-launch timer is removed; the manual
"Community: Check for updates" command still force-checks and hot-reloads.

## Behavior guarantees

- Steps run sequentially, ordered by `order` (default 1000) then registration.
- A step that throws, times out, or is skipped never blocks the vault. Failures
  are logged and summarized in one notice after launch.
- Nothing is shown unless the sequence is still running after 300ms, so a vault
  with nothing to do shows no flash. The overlay never takes focus.
- Timeout aborts the step's `signal`. A step that ignores the signal is
  abandoned (its late result is discarded); launch continues.
- Disabling or unloading a plugin drops its pending steps and aborts its running one.

## Plugin API

```ts
const dispose = app.launch.registerStep({
  id: "my-plugin:create-sandbox",   // must be "<pluginId>:<stepId>"
  title: "Creating sandbox",
  description: "Preparing an isolated workspace",
  order: 100,          // optional, default 1000
  optional: true,      // optional steps get a Skip button (default false)
  timeoutMs: 120_000,  // optional, default 60_000
  async run({ signal, setProgress, setTitle }) {
    setProgress("Pulling image");   // string = detail text
    setProgress(0.4);               // number 0..1 = step progress
    await createSandbox({ signal });
    // return "skipped" to report you chose to do nothing
  },
});
```

Register in `onload()`; steps registered after the `after-plugins` phase has
finished (e.g. in `onLayoutReady`) are not run. `app.launch` is exposed like
`app.onboarding` (also via `getInternalPlugin("launch")`).
Plugins cannot choose a phase. Manifest-declared steps are not supported
(runtime registration only).

### Example: Agent Threads sandbox creation

```ts
onload() {
  this.app.launch?.registerStep({
    id: "claude-threads:sandbox",
    title: "Preparing Agent Threads sandbox",
    optional: true,
    timeoutMs: 90_000,
    run: async ({ signal, setProgress }) => {
      if (!this.settings.sandboxEnabled) return "skipped";
      setProgress("Starting container");
      await this.sandbox.ensure({ signal, onProgress: setProgress });
    },
  });
}
```

Guard with `app.launch?` so the plugin still loads on Obsidian/older Geode.

## Open questions

- Manifest-declared (static) steps: skipped; cheap to add later like onboarding.
- An in-flight network install at the 15s timeout cannot be cancelled; no new
  item starts, but one half-finished install could race plugin load.
