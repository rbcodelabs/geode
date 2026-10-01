# Recommending onboarding steps from your plugin

Geode ships an `onboarding` core plugin: a checklist side pane ("Onboarding:
Open checklist") with a completeness score. Your plugin can add steps to it in
two ways. Design rationale: [ADR-0027](adr/0027-onboarding-internal-plugin.md).

## Step shape

| Field | Notes |
|---|---|
| `id` | Required. `"<your-plugin-id>:<step>"` (runtime API) or just `"<step>"` (manifest). |
| `ownerId` | Required in the runtime API. Your plugin id. |
| `title` | Required. Plain text. |
| `description`, `group`, `order` | Optional. Lower `order` sorts first (default 1000). |
| `optional` | Shown, but does not count toward the score. |
| `commandId` | Full command id (e.g. `"my-plugin:connect"`). The "Do it" button runs it. |
| `check` | `() => boolean \| Promise<boolean>`. Runtime only. When true the step completes itself. Errors count as incomplete. |
| `docsUrl` | Optional `http(s)` link. Runtime only. |

Steps without a `check` are ticked by the user.

## 1. Static: in `manifest.json`

Shown even if your plugin is installed but disabled (with an "Enable plugin"
button). Invalid entries are ignored with a console warning.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "minAppVersion": "0.1.0",
  "description": "Does things.",
  "author": "Me",
  "onboarding": {
    "steps": [
      { "id": "connect", "title": "Connect your account", "commandId": "my-plugin:connect", "group": "Setup" },
      { "id": "tour", "title": "Take the tour", "optional": true }
    ]
  }
}
```

## 2. Runtime: from `onload()`

The onboarding plugin loads before any vault plugin, so it is always available
when your `onload()` runs. Guard the lookup anyway, for older hosts.

```ts
import { Plugin } from "obsidian";

export default class MyPlugin extends Plugin {
  async onload() {
    const onboarding =
      (this.app as any).onboarding ?? (this.app as any).plugins?.getPlugin?.("onboarding");
    if (!onboarding) return;

    // The disposer is also called for you if the plugin is disabled, but
    // registering it makes cleanup explicit.
    this.register(
      onboarding.registerStep({
        id: "my-plugin:connect", // same id as the manifest step => upgrades it (adds check)
        ownerId: "my-plugin",
        title: "Connect your account",
        group: "Setup",
        commandId: "my-plugin:connect",
        check: async () => (await this.loadData())?.token !== undefined,
      })
    );
  }
}
```

- Registering a duplicate id throws `OnboardingRegistryError`.
- A runtime step with the same id as a manifest step overrides it field by
  field, so you can declare the step statically and add the `check` at runtime.
- Steps vanish when your plugin is disabled.
- On launch the checklist opens by itself (in the right sidebar, without taking
  focus from the editor) while any required step is incomplete and not skipped.
  Optional steps never trigger it. It stays closed if the user dismissed
  onboarding or the pane is already open, and under `GEODE_HEADLESS` (e2e).
  Register steps from `onload()` so they exist when the check runs.
- The checklist includes an optional first-party step, "Install and enable Agent
  Threads" (supported-catalog id `claude-threads`, which is the plugin's real id).
  Its `check()` passes only when the plugin is installed and enabled. Its "Do it"
  action (same `onboarding:install-agent-threads` command) installs the tested
  release through `CommunityManager.installSupported` if needed, then enables it
  through `PluginManager.enable`. Failures show a notice and never throw. It is
  not offered on hosts without the install API (mobile) or when headless.
- The same flow is offered as a "Recommended: Agent Threads" card at the top of
  the checklist pane (so it appears with the launch auto-open on a new vault).
  One Install click goes Installing, Enabling, "Installed and enabled". If the
  install works but enabling fails, the card shows "Installed, but couldn't
  enable" with an Enable retry (no reinstall). If the plugin is installed but
  disabled, the card shows Enable instead of Install. It is hidden when the
  plugin is installed and enabled, when headless, or when it is not installed
  and the host has no install API. "Not now" is saved in the onboarding state
  (`dismissedRecommendations`) and the optional step remains. Progress is
  indeterminate and Cancel only ignores the in-flight install result.
- Completion is stored per vault in `.geode/plugins/onboarding/data.json`. Users
  can skip a step, dismiss the whole checklist, or reset progress.
