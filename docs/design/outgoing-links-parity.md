# Outgoing links parity design

Date: 2026-10-14. Compass Task: `5d8e701c-4f02-4ead-8113-c29b3611bd7e`; Solution: `523dc576-9b4d-4028-a8d3-e2e5f765d45a`; KR: `c3b390f0-92a8-479c-b629-2b6745d577d5`. Status: accepted by the overnight orchestrator under the user’s explicit reversible-design authorization. Baseline: b939adf. No source changes in this document.

## Problem and constraints

Users can inspect incoming links but cannot inspect or create outgoing connections from the active note. Match the documented Outgoing links behavior using existing Electron/TypeScript/sidebar patterns, no dependency or public API change. Support a 280–360 px sidebar, keyboard operation, large vaults, and unsaved editor text. The source of truth is Markdown; indexes are read projections.

Public behavior reference: https://obsidian.md/help/plugins/outgoing-links. It requires existing links, potential links from names/aliases, excluded target filtering, full-path disambiguation, and click-to-link. The public page explicitly allows converting a mention inside a code block, while the resulting link must stay absent from the parsed Links section. Keep this distinction.

## Options

| Approach | Benefit | Tradeoff |
|---|---|---|
| New view using existing metadata plus a pure active-text candidate matcher (recommended) | Small independent package, uses established resolution, reads only the source text rather than scanning every note body | Matcher still walks names/aliases; cooperatively yield/cancel for large vaults |
| Reverse existing backlinks unlinked-mention results | Reuses familiar UI | Wrong direction, expensive many-file reads, code-block behavior differs |
| New portable vault-wide outgoing index/API | Potential reuse by CLI/plugins | Bigger API and cache invalidation scope without a present need |

## Integration seams

- Add `src/renderer/views/outgoing-links-view.ts` and pure matching helper `src/renderer/outgoing-links.ts`; export/reuse SidebarView from `views/sidebar-views.ts` with its existing visibility lifecycle, or duplicate only a narrowly scoped lifecycle if exporting would collide with concurrent work.
- `App` boot registers the new right sidebar view beside Backlinks; `app.ts` registers built-in commands using `CommandRegistry` from `commands.ts`; follow that registration path. Register one stable Show outgoing links command that reveals/reuses the view.
- `metadataCache.getFileCache(file).links` and `.embeds` are the existing parsed link interfaces, but the current cache misses Markdown links. For this pane use the existing pure wiki source extractor against the same current live text snapshot until the shared parser/cache fix lands; do not build a new parser. `getFirstLinkpathDest` resolves note/heading/attachment targets; `workspace.openLinkText` delegates normal navigation and new-tab modifiers. Do not invent `frontmatterLinks`: the current CachedMetadata interface has no such member.
- Preserve code-block filtering from the metadata parser, include note/heading/block and attachment references; deduplicate by authored target while preserving first appearance, showing an occurrence count. Missing references remain clickable through normal create-note behavior. External URLs are outside this documented internal-note package and must not be silently sent to the OS.
- Potential links come from active Markdown text and `vault.getMarkdownFiles()` + metadata aliases. Exclude the active file. Match full basename/alias with Unicode-aware word boundaries, case insensitive, preserving original text. Keep separate targets for identical names, label full path via title/accessibility label. Mask existing Markdown/wikilinks and YAML frontmatter to avoid nested links; do not mask fenced code for this view. Use exact offsets, not only line/snippet counts.
- No general Excluded files setting exists in the current renderer. Add one device-local per-vault list under `host.deviceState`, key scoped by the current vault root/ID following existing device-state conventions. Expose Settings → Files and links → Excluded files. A shared pure matcher normalizes separators and supports literal vault-relative file/folder prefixes plus slash-delimited regular expressions with bounded pattern length and a safe supported syntax (reject backreferences, nested repetition and unsupported constructs), compiled once on save; reject malformed patterns without replacing the last valid setting. This package filters only potential-link targets. It does not change indexing, links, search or sync behavior; broader consumers can adopt the shared matcher in follow-ups. Document this scope instead of suggesting all excluded-file behavior is complete. Sync excluded folders are unrelated and must not be reused as user note exclusions.
- Source text must come from the live active MarkdownView editor when open; fallback to vault.read only when there is no editable buffer. Conversion dispatches one editor transaction with exact matched range and `fileManager.generateMarkdownLink(target, source.path, "", matchedText)`; preserve alias spelling. Revalidate current source identity/text/range before dispatch; stale row re-renders without changing data. For a read-only/source-less host, disable conversion instead of writing stale disk text.
- Cancel/ignore stale scans on active file change, hide, close, vault switch and metadata refresh, following BacklinksView AbortController + generation precedent. Retain the old last-good content while loading same subject; clear immediately when subject changes. Explicit indexing/read error states, no unhandled promise rejection.

## Visual reference

Artifact `design-13b25764-6655-463d-bd18-a8902e3b0f18`, revision files `Artifacts/threads-design/create-a-reviewable-static-geode-sidebar-parity-reference-pr/{index.html,styles.css,app.js}`. Compact sibling of Backlinks: pane title, Links/count heading, target rows, Unlinked mentions/count heading, snippets with per-target buttons, subdued path text and visible keyboard focus. Follow current app tokens/styles; do not introduce another global theme.

## Acceptance criteria

1. Show outgoing links opens/reuses the right sidebar tab; it restores through existing workspace layout behavior; switching notes refreshes it and fileless/non-Markdown views show an explicit empty state.
2. Parsed wikilinks, Markdown note links, embeds, heading/block references and unresolved targets show with deterministic ordering/counts; normal/modifier activation navigates through existing handlers; code-block references are absent.
3. Source text mentioning an existing target basename or alias produces conversion buttons; matching names in two folders produce distinct buttons with full-path hover labels; self-target and already-linked spans do not produce suggestions.
4. Converting an alias preserves visible alias text, creates a resolvable unambiguous link, preserves every other byte, participates in editor undo, and updates both sections. A code-block mention can be converted but remains absent from Links.
5. Conversion uses unsaved live text and refuses stale ranges, deleted targets, changed active subject, or read-only files. No direct disk write can overwrite editor edits.
6. Excluded-file behavior passes supported pattern cases before the ledger row is verified. Without that UI/capability, report partial and name the gap.
7. Keyboard users can reach/activate target and conversion controls; untrusted names/snippets render as text; empty/loading/error states are tested.
8. Unit tests cover matching offsets, Unicode/punctuation boundaries, duplicate names, aliases, nesting avoidance and stale conversion. E2E covers active-note follow, real navigation, alias conversion, undo and persistence. Large candidate scans yield and cancel; no hidden-pane scan continues.

Riskiest assumption: all displayed offsets can refer to one consistent live editor snapshot while metadata targets resolve asynchronously. Revise toward an explicit snapshot generation if the integration cannot prove that invariant.

Out of scope for this package: backlinks changes, canvas outgoing graph, public plugin API additions, universal hover-preview settings. No claim that the whole linking specification is verified by this package alone.

Visual verification: rendered locally with installed Playwright Chromium at 1440×900 and 320×760; reviewed screenshots `desktop-outgoing.png` and `narrow-outgoing.png`, both legible with no horizontal overflow (narrow document scroll width 320). Artifact buttons switch all three pane references; conversion demonstrates success state only, not actual persistence.


## Review hardening — 2026-10-14

Independent review found quadratic rescanning of unmatched Markdown openers and
newline-free snippets, with cancellation only between target records. The approved
review fix uses one forward masking pass, precomputed line starts, byte/match
cancellation checkpoints, a 128 Ki-character source bound and at most 500 collected
matches. The pane announces limited coverage explicitly. This is a responsiveness
tradeoff: long/dense notes show a truthful subset and remain a parity limitation
until incremental scanning can safely expose the rest. Existing parser graph
coverage remains a separate package. No editor/disk mutation policy changes.
