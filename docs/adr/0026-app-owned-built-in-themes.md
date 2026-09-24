# ADR-0026: App-owned built-in themes

**Date:** 2026-09-20
**Status:** Accepted

## Context

Ivory was added only to `test-vault/.geode/themes/`. Electron-builder excludes
that test fixture, and theme discovery previously read only the current vault's
`.geode/themes/` directory. Consequently the released app and existing vaults
could list only Default unless the user separately installed a community theme.

ADR-0014 deliberately described upstream builds as shipping no theme, but its
deployer seeding mechanism solves a different problem: copying optional content
into a brand-new vault once. An app-owned theme must be available to every vault,
including vaults whose `.geode/` directory already exists, and must update with
the application rather than becoming a stale vault copy.

## Decision

Canonical built-in themes live under
`resources/builtin-themes/<id>/{theme.css,manifest.json}`, which is included by
the existing electron-builder `resources/**/*` rule. The desktop host exposes a
narrow theme API that:

- lists the sorted, deduplicated union of built-in and vault-local themes;
- validates theme ids before constructing either path;
- reads `.geode/themes/<id>/theme.css` first and the bundled copy second.

Ivory is the first built-in. A local same-name theme is an intentional override.
Removing that local copy reveals the bundled version again. Community
install/uninstall continues to own only vault files and therefore cannot delete
the app-owned copy. App updates replace the bundled theme atomically with the
rest of the application.

This decision revises only ADR-0014's premise that upstream ships no theme.
ADR-0014 remains the mechanism for optional deployer content copied into a
brand-new vault.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Keep Ivory in the test/demo vault | No host changes | Not packaged; unavailable to real or existing vaults |
| Seed Ivory into each vault | Reuses existing theme loading | Misses existing vaults; creates stale copies; mixes app and user ownership |
| Package Ivory as an app-owned built-in (chosen) | Available immediately; updates with the app; preserves community themes | Requires a narrow host API and explicit precedence rules |

## Consequences

- Desktop installations always offer Default and Ivory, even for pre-existing
  vaults with no themes directory.
- Vault-local themes remain portable and user-owned; same-name local content
  wins until removed.
- The renderer cannot use this API to read arbitrary packaged resources. Theme
  ids receive lexical/component validation (no separators, NUL, `.` or `..`)
  before either path is constructed. The API does not add realpath confinement
  for user-created symlinks inside the vault-owned themes directory.
- The bundled Ivory behavior is desktop Electron only. Mobile continues to use
  its native vault-theme provider; packaging a matching mobile built-in is a
  separate platform decision.

## Risks

The riskiest assumption is that name-based local precedence is sufficiently
clear to users who intentionally install a community theme named `Ivory`. If
built-in metadata or UI labeling later needs to distinguish ownership, the list
API can evolve to return typed descriptors instead of strings.
