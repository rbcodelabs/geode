# ADR-0036 sequencing addendum: isolated adapter preparation

**Date:** 2026-10-15
**Status:** Accepted by coordinator, 2026-10-15. Strictly unwired module and state
harness preparation; product integration retains the native-baseline gate.
Authorization covers tested PRs; no merge, release or parity claim.
**Decision source:** ADR-0036 in design commit `b884d13`

ADR-0036 requires a frozen integrated native/Canvas/PDF baseline before Editor
implementation. Permit a narrow preparation phase on frozen daily integration
`fe659b1` while native lifecycle corrections continue, without exposing or wiring
a product Editor interface. This is an explicit sequencing exception; the native
baseline gate remains mandatory for product integration.

One dedicated Task/isolated branch may add only a new unexported core adapter
module and isolated CM Text/EditorState/history tests. Inject the retained native
instance, current-owner predicate and editability guard. Follow ADR-0036's core
methods and provisional input/selection/history policy. Do not derive final host
lifecycle policy from this older baseline or bypass its injected guard.

Do not edit MarkdownView, App, Workspace, commands, menus, compatibility exports
or acquisition/callback types. Do not instantiate the adapter in the product, add
public runtime exports, mutate raw CM's shape, or implement packages 2/3. Existing
public/raw CM consumers continue unchanged. Test focus behavior only through a
host seam; real DOM focus and ownership/wiring remain unverified at this phase.

Regression-first state harness tests can establish conversion, fresh returned
objects, reversed/multiple selections, one-transaction mutation/history behavior,
and no dispatch on an injected stale/noneditable owner. They do not establish
actual Markdown lifetime, autosave, real plugin acquisition, conflict arbitration,
or Obsidian parity. Keep the 49 audited Editor rows unchanged/unknown.

Before any product use, rebase/carry the isolated module onto the coordinator's
frozen accepted native baseline, review the actual host editability/current-owner
contract, wire every public acquisition together, inventory native CM consumers,
and run the complete ADR-0036 integration/regression matrix. Treat the module as
preparation until that evidence exists; a passing isolated harness is not a
completed Editor feature.
