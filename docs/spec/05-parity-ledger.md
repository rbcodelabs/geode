# Obsidian parity ledger

The generated [`parity-ledger.json`](parity-ledger.json) is the traceability
baseline for Geode's Obsidian compatibility program. It inventories official
public requirements; it does **not** claim that Geode currently satisfies them.
Newly discovered rows default to `unknown` until a reviewer adds an explicit,
durable evidence mapping.

## Baseline and coverage

The generator reads these official repositories:

- `obsidianmd/obsidian-help`: every Markdown page below `en/`
- `obsidianmd/obsidian-developer-docs`: every Markdown page below `en/`,
  including developer guides, CSS references, top-level TypeScript API pages,
  and generated member-level API pages
- `obsidianmd/obsidian-api`: every exported top-level declaration in
  `obsidian.d.ts`, plus the public named members of classes, interfaces, enums,
  and object type aliases
- `obsidianmd/obsidian-help/Release notes`: every list-item delta in desktop
  releases 1.13.2, 1.13.3, and 1.13.4, which closes the prior 1.13.1 snapshot
  gap. This explicitly includes image lightbox, navigation, zoom/pan, and Live
  Preview image selection, resizing, editing, and layout refinements.

The checked-in baseline contains 2,850 rows: 173 help pages, 1,319 developer
pages, 50 changelog deltas, 299 public API declarations, and 1,009 public API
members. Generated IDs are a kind prefix plus the first 12 hexadecimal digits
of a SHA-256 hash over the row's canonical source identity. IDs do not depend on
filesystem location, generation time, or row order.

## Status and evidence policy

Allowed statuses are:

- `verified`: directly observed by the referenced automated test or durable QA
  artifact
- `partial`: evidence observes only part of the requirement
- `missing`: evidence demonstrates that the behavior or contract is absent
- `intentionally-equivalent`: evidence demonstrates a documented Geode-owned
  equivalent rather than identical branding or infrastructure
- `blocked`: evidence records the external/input constraint preventing closure
- `unknown`: no explicit assessment has been made

Status overrides live in [`parity-evidence.json`](parity-evidence.json), keyed
by generated requirement ID. Any status other than `unknown` requires at least
one evidence reference. Unknown IDs, invalid statuses, and evidence-free status
claims fail generation. Name matching or code inspection alone never upgrades a
row to `verified` — and for DOM-rendering-surface rows, neither does unit-test
evidence by itself; see [DOM-surface evidence policy](#dom-surface-evidence-policy)
below.

Example:

```json
{
  "HELP-0123456789ab": {
    "status": "verified",
    "evidence": ["tests/e2e/example.spec.ts"],
    "notes": "Observed behavior covered by the named test."
  }
}
```

## DOM-surface evidence policy

A prior incident shipped through two releases because a custom-icon rendering
bug was marked `verified` on tests that mocked or aliased Obsidian's API and
never exercised a real Geode/Electron render. To close that gap, every
requirement row carries a generator-computed `surface: "logic" | "dom"`
classification, and **DOM-rendering-surface API claims cannot be `verified` on
unit-test evidence alone — they require at least one `tests/e2e/`-prefixed
evidence path.**

Surface is classified at generation time from the syntax of `obsidian.d.ts`
only (no type checker), in this priority order:

1. **Class allowlist** — every member of any of these classes/interfaces is
   `dom`, regardless of the member's own declared type:

   ```
   View, ItemView, FileView, TextFileView, EditableFileView, Modal,
   SuggestModal, FuzzySuggestModal, Menu, MenuItem, Notice, WorkspaceLeaf,
   HoverPopover, AbstractInputSuggest
   ```

2. **Declared-type token match** — a member's declared type (for methods, the
   return type plus every parameter type, combined), or a top-level
   function's return+parameter types, matching this pattern is `dom`:

   ```
   /\b(HTMLElement|HTMLDivElement|HTMLSpanElement|SVGElement|SVGSVGElement|DocumentFragment|Element)\b/
   ```

3. **`Workspace`/`WorkspaceItem` keyword scope** — for members of `Workspace`
   or `WorkspaceItem` specifically, a member name matching this pattern is
   `dom`:

   ```
   /icon|split|tab|ribbon|sidebar|dock|drawer|view/iu
   ```

4. **Top-level function exception** — `addIcon` and `removeIcon` are `dom` by
   exact function name at the `api-declaration` level. This is a
   hand-maintained literal list: their signatures are plain strings/`void`
   with no syntactic DOM signal to infer from.

5. Everything else is `logic`. This includes every `help-page`,
   `developer-page`, and `changelog-delta` row (no computation needed — always
   `logic`), and the top-level class/interface/enum/type-alias declaration
   rows themselves (as opposed to their members).

A row's evidence entry may override the computed default with an explicit
`"surface": "dom" | "logic"` field. Any explicit override — in either
direction — requires a non-empty `notes` string explaining why the computed
default doesn't apply. Name matching or code inspection alone never upgrades
a row to `verified`, and neither does asserting a `surface` override without
a `tests/e2e/` reference when the resolved surface is `dom`; see the two
examples below.

`dom`-surface row, verified on a real-Electron test:

```json
{
  "API-MEMBER-200ae2a05b18": {
    "status": "verified",
    "evidence": ["tests/e2e/view-icon.spec.ts"],
    "notes": "Observed the rendered tab icon after mounting a custom View in a real Electron window."
  }
}
```

Explicit surface override, with its required note:

```json
{
  "API-MEMBER-0123456789ab": {
    "status": "missing",
    "evidence": ["docs/spec/00-overview.md"],
    "surface": "dom",
    "notes": "Overridden to dom: this member paints a status-bar spinner despite its void return type, which the syntactic classifier cannot see."
  }
}
```

## Refresh procedure

1. Clone or update the three official repositories at the paths below and
   record their commit SHAs in the reviewing change description:

   ```sh
   git clone https://github.com/obsidianmd/obsidian-help /private/tmp/geode-audit-obsidian-help
   git clone https://github.com/obsidianmd/obsidian-developer-docs /private/tmp/geode-audit-obsidian-developer-docs
   git clone https://github.com/obsidianmd/obsidian-api /private/tmp/geode-audit-obsidian-api
   ```

2. Generate the ledger and inspect the JSON diff:

   ```sh
   npm run parity:generate
   git diff -- docs/spec/parity-ledger.json
   ```

3. Run the deterministic staleness check and targeted tests:

   ```sh
   npm run parity:check
   npm run test:unit -- --run tests/unit/parity-ledger.test.ts
   ```

Alternative clone locations can be supplied directly:

```sh
node scripts/generate-parity-ledger.mts \
  --help-root /path/to/obsidian-help \
  --developer-root /path/to/obsidian-developer-docs \
  --api-root /path/to/obsidian-api
```

The artifact contains no timestamp or absolute local path, so identical source
trees and evidence produce byte-identical output.
