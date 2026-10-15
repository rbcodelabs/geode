# Safe file properties P1 implementation

Date: 2026-10-14. Task `e7954a61-948a-4c00-b74d-227692c1c0fc` → Solution `523dc576-9b4d-4028-a8d3-e2e5f765d45a` → KR `c3b390f0-92a8-479c-b629-2b6745d577d5`.

Scope follows the accepted P1 in architect commit `b0b44d2:docs/design/properties-parity.md` and [ADR-0031](../adr/0031-sidebar-properties-parity.md). The overnight user instruction authorizes reversible implementation and tested PRs; merging and release remain excluded. This branch stacks on outgoing-links commit `96dbb21`, reusing its guarded buffer mutation seam.

`PropertyEditor` owns shared DOM controls, input validation and focus tokens. `property-source` strictly parses the latest YAML document and applies one operation, retaining unrelated AST content and body bytes. `FilePropertiesView` owns active-file/split identity, subscriptions and stale event guards. The CodeMirror widget supplies a separate owned-buffer adapter to the same controls. No property control writes directly to disk.

The internal source mutation helper accepts an explicit `allowReading` option (default false); Properties opts in, while outgoing links retains its existing Reading restriction. Existing conflict/vault-switch/preimage/range guards remain. A successful Reading mutation refreshes its rendered display. Dirty focused fields survive unrelated cache updates; field-level expected values reject concurrent overwrites. Sidebar rebinding tracks both file and owning split. Unsupported nesting and malformed input are refused, including BOM-prefixed frontmatter.

Visual reference: approved sidebar design artifact `create-a-reviewable-static-geode-sidebar-parity-reference-pr`, desktop-properties state. Existing metadata CSS/tokens are reused, with individual list fields, explicit errors and semantic buttons. Screenshot capture, demo-vault inspection and Electron execution remain pending the orchestrator's exclusive verification slot.

## Verification checkpoint

Local machine; `pm-config.md` has no compute-offload entry. Five targeted unit files pass (29 tests): property serialization/data integrity, pane ownership/lifecycle, outgoing source helper/default Reading restriction and outgoing pane regression coverage. Independent review regressions reproduce detached split callbacks and stale Reading metadata; adapters now bind generation and owner, and Reading derives properties from its buffer with asynchronous render identity guards. Typecheck and build pass. Test-first regressions included stale split ownership (old buffer incorrectly retained), invalid YAML/numbers, duplicate operations, comments and CRLF body preservation.

`tests/e2e/file-properties.spec.ts` prepares synthetic-vault verification for shared in-note/sidebar values, unsaved body preservation, isolated undo, duplicate rename, lists, active-file switching and malformed YAML. It has not yet run at this checkpoint. Full units, full Electron, manual visual inspection and screenshot publication remain required before a tested PR claim. Properties ledger rows remain partial; P2/P3 registry, global operations and presentation are deferred explicitly.
