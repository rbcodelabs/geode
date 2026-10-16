# Properties editor and sidebar parity design

Date: 2026-10-14. Status: accepted recommendation for authorized overnight implementation. Baseline b939adf. Task `5d8e701c-4f02-4ead-8113-c29b3611bd7e` → Solution `523dc576-9b4d-4028-a8d3-e2e5f765d45a` → KR `c3b390f0-92a8-479c-b629-2b6745d577d5`. Companion decision: ADR-0031.

## Problem and discovery correction

Users can edit basic inferred properties in Live Preview already: `PropertiesWidget` in `src/renderer/markdown/live-preview.ts` adds, renames, removes and edits string/list/number/boolean values, dispatching an editor transaction. Reading mode calls `renderProperties` separately. Neither sidebar exists. Type-icon selection, a persisted vault-wide registry, date/time controls, document display preference and full property keyboard behavior remain gaps. Triage wording must be corrected rather than counting a pre-existing widget as new delivery.

Public references: https://obsidian.md/help/properties and https://obsidian.md/help/plugins/properties. The target has active-file and all-vault panes; all-vault entries expose type, sorting/search and global rename. Document properties have typed fields and visible/hidden/source presentation. Type assignments apply by property name across a vault. The implementation criteria below add safety and integration decisions specific to Geode.

## Options considered

| Approach | Benefit | What it gives up |
|---|---|---|
| Extract current controls with buffer/registry adapters (recommended) | One field implementation in note and sidebar, preserves existing undo | A measured refactor before finishing sidebar parity |
| New standalone sidebar forms only | Fastest initial active-file pane | Divergent editing/type behavior from document widget |
| Rewrite as an editor framework or new dependency | Rich reusable component system | Unnecessary architectural churn and compatibility risk |

Recommend shared controls and an owned registry with the existing metadataTypeManager as compatibility adapter. No additional dependency or public signature change. The root user authorizes reversible choices; the parent orchestrator can select this recommendation without waking the user.

## Bounded delivery order

### P1 — Reusable, safe controls and file pane

- Extract `PropertiesWidget` control rendering to `src/renderer/properties/property-editor.ts`; keep CodeMirror wrapper in live-preview.ts. A renderer receives current property data, type resolver, on-mutate adapter and focus restoration token; it does not own files or serialize Markdown itself. Reuse existing `.metadata-*` CSS, icons and whitespace. Add `views/file-properties-view.ts`, right-sidebar registration and Show file properties command. Minimize editor-owned file changes; coordinate with folding/multi-cursor branch before modifying MarkdownView.
- Treat a mutation as an operation on the latest parsed object, never a captured entire object. Read source text via `MarkdownView.getText()` and dispatch one minimal frontmatter replacement through its live editor. The view exposes a narrowly scoped internal helper guarded by existing vault-switch/conflict-read-only checks if direct dispatch cannot enforce them. Existing private writeFrontmatter currently normalizes newlines; improve/reuse the pure frontmatter transform after strict parse validation, preserving CRLF and note body bytes. Do not call the current permissive patchFrontmatterText on malformed input without a strict preflight.
- `FileManager.processFrontMatter` is queued but does not protect against open dirty editors; do not use it as the file-pane write path. Reading mode retains an editor internally: route through the same buffer and update Reading display. If no owned editable buffer exists, show values read-only with Open note action.
- Property names must be nonempty and unique. Duplicate rename/add shows an inline error and preserves source; never silently replace an existing key. Invalid YAML, duplicate YAML keys, non-map root and unsupported nested values show an explicit source-mode action. Preserve unsupported content; a disabled field is safer than stringifying `[object Object]`. Using a map/object must protect special keys such as `__proto__`/`constructor`.
- File pane follows centre active Markdown note, survives its own focus, clears on fileless/non-Markdown views, subscribes to metadata/file changes, and disposes subscriptions on close. During a field edit, unrelated metadata events must not destroy input/focus; rerender after commit or reconcile only untouched fields.

P1 is useful independently but must retain partial Properties ledger status until later criteria pass.

### P2 — Registry, types and document presentation

- Add `properties/property-types.ts` as the single internal owner. Load/store validated data through `host.config.read/write("types")` using `{types: {normalizedName: type}}`; this config is vault-scoped under the current host contract. Preserve unknown future keys/types, but expose only supported UI types. Use lowercased names for lookup to match the existing compatibility shim, preserving authored keys for display. Missing assignments infer deterministically from existing primitive/list values; fixed special names retain correct list/tags semantics.
- Replace the shim construction in `api/obsidian.ts` with an adapter to this owner retaining `getAllProperties`, `getPropertyInfo`, `setType` behavior. Install owner before plugins initialize; lightweight App test doubles retain a compatible fallback. Never maintain two independent mutable maps. Expose registry changes so controls and All properties refresh. Plugin-assigned unknown types remain inspectable and safe rather than crashing widgets.
- Type picker supports text, list, number, checkbox, date and datetime; tags is special to tags. Store date/time values as strings without converting time zones. List editing must preserve scalar element values rather than splitting arbitrary strings by comma; use individual chips/fields, including empty/list transitions. Number accepts only finite literal numbers; invalid input stays editable with a message, never coerces to text or zero. Null booleans retain an unset state. Changing type changes interpretation, with per-value validation; do not rewrite all vault values on registry selection.
- Add Settings → Editor → Properties in document: visible (default), hidden, source. Device-local app setting initially; no portable sync schema expansion in this package. Apply consistently to Live Preview and Reading while Source editing remains source. Hidden keeps file sidebar editable. Source displays raw YAML where rendered view requires a source block. Record sync portability as separate work until explicitly implemented.
- Wire Add file property palette command, Cmd/Ctrl+semicolon, note actions menu and blank-first-line frontmatter into shared editor. Tab/Shift+Tab and arrows move fields, Escape returns to row, Alt+Down returns to body, delete key command removes the focused/selected property, normal undo/redo uses document transactions. Do not hijack text cursor arrows inside an input. Tags autocomplete uses existing metadata tag inventory; property-name autocomplete uses registry/inventory. Links remain safe interactive values without Markdown rendering.

### P3 — All properties inventory and rename

- Add `views/all-properties-view.ts`. Derive a map of property names to file counts from `metadataCache.getFileCache(file).frontmatter` across Markdown files; count once per note. Ignore parser bookkeeping fields if any (current pure parser should be checked). Incremental updates or coalesced recomputation; don't read each file body on every render. Name sort uses stable name/path tie breaking; frequency sorts descending with name tie breaking. Persist sort choice device-locally. Each row shows type/name/count; Show all properties opens/reuses the tab. Search invokes `app.openSearch` with property syntax, escaping special characters through existing query parser contract instead of concatenating raw names.
- Context menu provides rename. First produce a complete plan with affected count, proposed name, collision list, unreadable/malformed files, and any dirty open file. Do not start writes if destination keys exist or any file cannot be changed safely. User confirmation in the feature UI is a product behavior, not an overnight-agent approval request.
- Apply to latest source through the same buffer adapter for open notes and a serialized read/verify/write path for closed notes. Recheck file identity and source preimage immediately before each write; use existing version/conflict guard when available. No optimistic success toast before every planned file is accounted for. If a file changes mid-run, stop and show completed/pending paths for explicit retry; preserve old/new registry entries until reconciliation, never auto-roll back over newer edits. If current host cannot guarantee closed-file preimage integrity, ship preview only and keep rename criterion partial rather than invent an unsafe CAS guarantee.
- Rename preserves each value, field order where feasible, all unrelated keys and body text. Keep existing destination data intact. A no-op/empty/duplicate name is rejected or no-op. Registry rename happens after successful file operations; partial runs display both names accurately.

## Exact acceptance and test contracts

1. Active-note pane editing and in-note controls share the same component; editing either updates the other, Reading and saved YAML without losing unsaved body text. One undo reverses a committed field mutation.
2. Add, rename, remove and edits round-trip string/list/finite number/true/false/null/date/datetime/tags; quoted internal links, commas inside list items and CRLF survive. Source/hidden/visible presentation passes all supported modes and restart.
3. Malformed YAML, duplicate keys, nested values, existing-name collisions and invalid numbers never trigger destructive writes; errors are visible and keyboard reachable.
4. Registry assignment survives restart, stays vault-scoped, updates every same-name control, and existing metadataTypeManager plugin calls operate on the same registry. Unknown imported type names survive persistence.
5. File pane handles active-note switches, its own focus, file deletion/rename, no-note state, metadata bursts, external edits and read-only conflict state. Stale commits cannot edit a newly active note. No hidden-pane work or closed-view subscriptions leak.
6. All properties inventory has correct note-frequency counts, sorting, type display and search query behavior including punctuation in keys; it updates on add/remove/rename and empty vaults.
7. Global rename plan and apply cover collisions, open dirty notes, failures mid-run, stale preimages, unsupported YAML, deleted files and registry consistency. Until these tests pass, keep global-rename parity partial.
8. Keyboard primary flows and semantic labels pass focused E2E; safe text rendering covers property values and names. Add at least one E2E that edits an unsaved body then edits a sidebar property and verifies both persist.
9. Keep HELP-eb3c5079b6e7 and HELP-4df0a02a2c6e partial until their entire page behavior has evidence. P1/P2/P3 PRs each state which acceptance criteria they meet and what remains; no aggregate completion claim from a screenshot.

## Visual reference and verification

Artifact `design-13b25764-6655-463d-bd18-a8902e3b0f18`, local artifact folder `Artifacts/threads-design/create-a-reviewable-static-geode-sidebar-parity-reference-pr`. It has file and all-property states reachable using sidebar tab buttons, a malformed-source warning reference and a rename reference. `desktop-properties.png` and `desktop-all-properties.png` are 1440×900 captures; `narrow-outgoing.png` verifies 320 px responsive sidebar treatment. Existing Geode tokens, compact controls and visible focus outline govern production implementation. The artifact is synthetic interaction guidance, not a production proof.

## Risks and revision triggers

Largest risk: sidebar changes can race autosave/source edits and overwrite data if they bypass the live editor. Second risk: type registry shim replacement can change third-party behavior. Favor small adapter tests and reject uncertain writes. Revisit the approach if source/buffer consistency cannot be enforced through existing MarkdownView and FileManager seams; that warrants a focused shared-document mutation design, not hidden refactoring inside a sidebar PR. Persisting types through host config must be confirmed against host allowlists before coding; if disallowed, add an explicit bounded config entry and tests rather than write an arbitrary vault file.
