# ADR-0016: Exact plugin compatibility certificates

**Date:** 2026-09-04
**Status:** Accepted

## Context

Geode truthfully advertises Obsidian API compatibility (1.8.0 when this ADR was
accepted; `GEODE_API_VERSION` has since moved to 1.10.2 — see Amendment). Minimal Theme
Settings 9.0.0 declares 1.13.0 because it uses the new declarative settings
surface, even though the concrete runtime surface it needs is small. Raising
Geode's global version would admit every plugin requiring APIs through 1.13,
most of which have not been verified.

Community updates introduce a related time-of-check/time-of-use risk: the
renderer previously resolved an update candidate, then asked the main process
to install the latest release again. A newer, uncertified release could appear
between those operations.

## Decision

Keep `GEODE_API_VERSION` below the certified plugins' declared minimum and centralize plugin admission in one
manifest-identity predicate. Add one certificate for the exact tuple:

| id | version | maximum declared minAppVersion | platform |
|---|---:|---:|---|
| `obsidian-minimal-settings` | `9.0.0` | `1.13.0` | desktop |

Plugin enable and community-update admission both use this predicate. Updates
install the already-admitted release tag, validate the tracked identity before
install, and pass the expected identity to the main process. The main process
parses and validates the downloaded staged manifest bytes before replacing the
known-good destination. Returned metadata is checked again before reload.

The certified API slice includes declarative groups, flat render items,
toggle/dropdown bindings and persistence, slider behavior used by the plugin,
and an App-owned allowlisted vault-config adapter. `AppSettings` remains the
single persisted source of truth. Config mutation order is mutate, apply DOM
and CSS, persist, then emit `config-changed` and `css-change`; failed writes
roll back the in-memory and applied state and emit no host events.
Minimal Settings also explicitly triggers `css-change` after its theme command;
that plugin-owned event is outside the host mutation transaction and can occur
before persistence, while Geode's single host-owned event remains ordered after
the successful write. Repeated same-value host calls are idempotent.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Raise global compatibility to 1.13 | Simple manifest gate | Falsely admits unverified plugins and APIs |
| Generic capability declarations | Extensible in theory | Existing plugin manifests do not declare granular capabilities |
| Exact identity certificate (chosen) | Narrow, testable, truthful | Each additional version requires explicit verification |

## Consequences

- Minimal Theme Settings 9.0.0 can run on desktop without broadening Geode's
  compatibility claim.
- 8.9.9, 9.0.1+, a modified 9.0.0 requiring more than 1.13.0, mobile, and
  arbitrary 1.13 plugins remain blocked.
- Update resolution and installation are pinned and fail closed before atomic
  replacement if staged bytes differ from the admitted identity.
- Declarative forms outside the tested slice fail visibly instead of silently.
- The riskiest assumption is that this exact plugin's undocumented config and
  body-class behavior remains stable for 9.0.0. Any new release must earn a new
  certificate through unit and Electron coverage.

## Verification

Unit coverage exercises the certificate matrix, enable/update parity, staged
manifest validation, declarative binding/idempotency/legacy behavior, slider
semantics, config validation and persistence ordering. Electron coverage runs
the unmodified official Minimal Theme Settings 9.0.0 release bundle. The fixture
includes the upstream MIT license and records its release URLs, exact identity,
and SHA-256 hashes for reproducibility.

## Amendment 2026-10-20: TaskNotes 4.13.10

`GEODE_API_VERSION` is now 1.10.2 (Bases plugin API landed). The decision above
is unchanged: the global level stays below 1.13 and 1.12 so unverified plugins
stay blocked.

A second certificate admits the unmodified release bundle of TaskNotes:

| id | version | maximum declared minAppVersion | platform |
|---|---:|---:|---|
| `tasknotes` | `4.13.10` | `1.12.2` | desktop |

TaskNotes declares 1.12.2, but gates the newer surface (CLI handlers at 1.12.2,
`SettingGroup` at 1.11.0, Bases at 1.10.1) at runtime with `requireApiVersion`.
Geode's `requireApiVersion` compares against `GEODE_API_VERSION`, so TaskNotes
takes the 1.10.2 code path; the certificate does not make Geode claim 1.12.
The runtime slice it needs, added alongside: `AbstractInputSuggest`,
`SettingGroup`, `TAbstractFile`, `editorInfoField`, `editorLivePreviewField`,
`getIconIds`, `getLanguage`, `parseFrontMatterAliases`, `requireApiVersion`, and
`MarkdownView.getMode()`.

Each TaskNotes release changes the tuple and must earn its own certificate via
`tests/e2e/tasknotes-compat.spec.ts` against the new bundle. Not covered:
TaskNotes' optional HTTP API server, webhooks, OAuth calendar sync, and mobile.
