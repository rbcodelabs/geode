# ADR-0011: Per-vault hotkey management and deterministic conflict handling

**Date:** 2026-08-31
**Status:** Proposed

## Context

Geode currently lets each command declare at most one string hotkey. The renderer
stores those bindings in a `Map<string, Command>`, so a duplicate silently becomes
"last registration wins." Core and plugin commands share the registry, and the
renderer publishes the currently bound strings to Electron main so hotkeys pressed
inside a `<webview>` guest can be intercepted and forwarded to the host.

Obsidian-parity requires a searchable Hotkeys settings tab, zero or more bindings
per command, per-vault overrides, plugin commands, conflict visibility, and live
updates. A saved binding must represent the physical key pressed rather than the
character produced by the current keyboard layout.

Hard constraints:

- An exact duplicate binding may not be silently accepted. The user must explicitly
  cancel or reassign it.
- Dispatch must be deterministic in the host document and in webview guests.
- Overrides live in `<vault>/.geode/hotkeys.json` and must survive commands that are
  temporarily absent because a plugin is disabled.
- `.obsidian/hotkeys.json` import belongs to the separate existing import work.
- `pm-config.md` migration is unrelated and is excluded.
- The portable renderer also runs in browser/mobile hosts, where Electron guest
  forwarding and often a hardware keyboard are absent.

Done means a user can find any registered core or plugin command, assign multiple
physical-key bindings, remove/reset them, filter assigned commands, resolve an exact
conflict explicitly, and observe the new bindings immediately without restarting.

## Decision

### 1. Separate command registration, declared defaults, and effective bindings

Keep `app.commands.commands` as the live Obsidian-compatible command object keyed by
command id. Extend a command to declare `hotkeys?: Hotkey[]` (and retain the existing
singular `hotkey` input as a deprecated compatibility adapter during migration).
These are **defaults**, not mutable user state.

Add a hotkey manager owned by the app/registry with three responsibilities:

1. normalize and index command-declared defaults;
2. load/save per-vault overrides;
3. resolve the effective bindings and publish one immutable snapshot used by the
   settings UI, host-document dispatch, and desktop guest forwarding.

For command id `C`:

```text
effective(C) = overrides[C]  if C has an override entry (including [])
               defaults(C)   otherwise
```

An empty array therefore means "remove every default." Deleting the override entry
means "reset to defaults." Persist only override deltas, not a snapshot of every
registered command. Preserve override entries for unknown command ids so disabling
and re-enabling a plugin does not erase user choices.

Recommended v1 file shape:

```json
{
  "version": 1,
  "overrides": {
    "command-palette": [],
    "sample-plugin:run": [
      { "modifiers": ["Mod", "Shift"], "code": "KeyP" }
    ]
  }
}
```

Writes use the existing vault-scoped config boundary (`config.write("hotkeys", ...)`),
which maps to `.geode/hotkeys.json` on Electron and the active vault's config store on
portable hosts. Writes should be atomic at the host boundary, as existing config
writes are.

### 2. Use a structured, physical-key representation

The canonical binding is:

```ts
interface Hotkey {
  modifiers: Array<"Mod" | "Ctrl" | "Meta" | "Alt" | "Shift">;
  code: string; // KeyboardEvent.code / Electron Input.code, e.g. "KeyP", "Comma"
}
```

Normalize modifier order as `Mod`, `Ctrl`, `Meta`, `Alt`, `Shift`, reject modifier-only
bindings, and derive a stable identity from normalized modifiers plus `code`.
`Mod` remains Cmd on macOS and Ctrl elsewhere; explicit `Ctrl` and `Meta` remain
distinct for plugins that request them. Display labels are a presentation concern:
translate `code` to US-keyboard labels and platform modifier glyphs without changing
the stored identity.

Both DOM `KeyboardEvent` and Electron `before-input-event` must normalize from
`code`, not `key`. If a host event lacks a usable physical code, it must not invent a
layout-dependent saved identity. Runtime compatibility parsing may translate legacy
string defaults such as `Mod+P` to `Mod+KeyP` and named keys such as `Escape` to their
same-named code.

### 3. Exact conflicts require an explicit transaction

An exact conflict is equality of normalized modifier set and physical `code`. When an
assignment would duplicate an effective binding owned by another command, the
manager returns a conflict result and makes **no mutation**. The UI offers:

- **Cancel** — leave both commands unchanged.
- **Reassign** (explicit override) — in one transaction, remove that binding from all
  current owners by writing their resulting effective arrays as overrides, then add
  it to the target command and persist once.

The UI must identify every displaced command. It must not offer a silent "save
anyway" path. Assigning a binding already present on the same command is an
idempotent no-op.

The normal invariant is one owner per exact binding. If malformed/manual config,
legacy defaults, or plugin defaults violate it, the snapshot records the conflict,
the settings UI highlights every owner, and dispatch for that binding **fails closed**
(runs no command). This is deterministic and avoids registration/load order deciding
which command executes. Reassigning through the UI repairs the conflict.

Conditional `checkCallback` availability does not change ownership: Geode must not
fall through from an unavailable owner to another command. Under the invariant there
is only one owner; an unavailable command yields no dispatch.

### 4. One snapshot drives live updates and guest forwarding

Recompute the effective snapshot when any of these occurs:

- overrides finish loading or are edited/reset;
- a core or plugin command is registered, replaced, or removed;
- a plugin unloads/reloads.

Notify subscribers once per committed snapshot. The settings tab rerenders its
search/filter/conflict state, the capture-phase document listener reads the new
index, and desktop republishes only the snapshot's **unambiguous dispatchable**
binding identities to main. Main then intercepts only those bindings in webview
guests and forwards the same canonical identity. Conflicted and unbound keys pass
through to the guest/page; they are never swallowed without a runnable owner.

Plugin commands are first-class because they register into the same command record.
Plugin-provided `hotkeys[]` become defaults; user overrides take precedence. Unload
removes the command/defaults from the active snapshot but retains its saved override.

### 5. Portable browser/mobile behavior

The hotkey manager and settings UI remain renderer-portable and use the host config
contract. Browser/mobile hardware-keyboard events use the same `KeyboardEvent.code`
path when available. Touch-only devices can still inspect, remove, and reset
assignments; recording a new binding should be disabled or explain that a hardware
keyboard is required when no qualifying keyboard event is available.

Electron-only guest publication stays capability-gated by `embeddedWebContent` and
`desktop`. No guest bridge is introduced on mobile. OS-reserved shortcuts may be
stored but cannot be guaranteed to arrive at Geode; the recorder should warn rather
than claim they are runnable.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Keep string hotkeys and let the last registered command win | Smallest diff | Layout-dependent; only one binding; plugin load order changes behavior; violates explicit conflict requirement |
| Store complete resolved bindings for every command | Simple dispatch and file inspection | Copies defaults into user state, makes new defaults/migrations stale, loses absent-plugin intent distinctions |
| **Store override deltas and compile an effective immutable snapshot (chosen)** | Matches per-vault semantics; preserves plugin overrides; one deterministic source for UI/host/guest | Requires a resolver and compatibility adapter |
| Permit duplicates and choose by priority/context | Supports layered scopes | Adds a policy UI and implicit behavior not requested; availability/context can make dispatch surprising |

## Test Contract

Unit tests must pin:

- physical `code` normalization parity between DOM and Electron inputs, including
  letters, punctuation, named keys, modifier ordering, `Mod`, and modifier-only input;
- multiple defaults, override replacement, empty override, reset-to-default, unknown
  command override retention, and legacy singular-default adaptation;
- exact conflict detection is normalization-order independent and causes no partial
  write;
- explicit reassign removes all prior owners and adds one target atomically;
- malformed duplicate ownership fails closed regardless of registration/object order;
- unavailable `checkCallback` does not fall through;
- plugin register/remove/re-register preserves the saved override and emits live
  snapshots;
- failed config writes do not publish a partially committed in-memory binding state.

Integration/E2E tests must pin:

- Settings → Hotkeys search, assigned-only filter, multiple assignment, remove,
  reset, conflict prompt, cancel, and reassign;
- persistence in a throwaway vault and isolation between two vaults;
- plugin command appearance and live add/remove/reload behavior;
- host-document dispatch changes immediately;
- a changed binding works immediately inside a webview guest, an old binding stops
  being swallowed, a conflicted binding passes through, and one press fires once;
- browser/mobile config round-trip and graceful hardware-keyboard absence.

## Consequences

Multiple bindings and plugin commands become uniform, while the public command record
retains the object identity existing plugins expect. Defaults can evolve without
rewriting vault files. Exact ambiguity is visible and safe rather than dependent on
plugin order. The tradeoff is a small resolver layer and a deliberate internal move
from human-readable combo strings to physical key codes.

`.geode/hotkeys.json` is Geode's native schema. Importing Obsidian's `key`-based file
is a separate adapter in the existing import workflow and must not be called by the
core hotkey manager.

## Risks

- **Riskiest assumption:** Electron's guest input consistently supplies `code` with
  semantics matching `KeyboardEvent.code` across supported platforms. Verify this
  with an Electron integration test before removing the legacy runtime fallback.
- Some international keyboards expose codes whose US display label is unfamiliar;
  storage and dispatch remain correct, but display/recorder UX needs validation.
- Plugins may mutate `app.commands.commands[id].hotkeys` directly. Plain-object
  compatibility cannot observe arbitrary deep mutation; supported live changes must
  go through registration or hotkey-manager APIs, and this limitation should be
  documented.
- Two windows on the same vault can race config writes unless the existing config
  boundary serializes them. If multi-window hotkey editing is supported, add revision
  or external-change reconciliation rather than last-writer-wins.

Revisit this decision if Geode adds context-specific/chorded shortcuts, because a
single global exact-binding owner is intentionally narrower than a layered keymap.
