# ADR-0013: Configurable cap on per-file metadata body scanning

**Date:** 2026-08-31
**Status:** Accepted

## Context

`parseMetadata` (`src/renderer/metadata-cache.ts`) does exhaustive position-span
extraction over a note's body: wikilinks, embeds, in-body tags, headings, sections,
and list items. Cost scales with body size — both CPU (several regex passes) and
allocated metadata (one object per match, each carrying a `Loc`/`Pos`).

A vault of 878 Markdown files (AI session transcripts, up to 1.6MB each) produced over
4.8MB of extracted metadata for a single file, and OOM'd both the renderer's metadata
index and the background utility-process indexer (`src/indexer/indexer-process.ts`,
which runs the same `parseMetadata`). This is a real, if uncommon, vault shape: very
large individual notes, not an unusually large file *count*.

A fixed threshold verified in a local build (300,000 bytes of body, post-frontmatter)
resolved the OOM without regressing normal-sized notes. But "how big is too big" is a
tradeoff between navigation completeness (headings/tags/links/list-items inside a
huge note) and memory safety, and that tradeoff depends on the user's vault content
and available memory — it should not be a hardcoded constant.

## Decision

1. **Threshold, not disable-by-file-type.** Cap on `body.length` (after frontmatter is
   stripped), checked once, right before the expensive scan. Frontmatter itself and
   frontmatter-derived `aliases`/`tags` are computed before the check and are never
   affected — those are cheap regardless of body size.

2. **Explicit parameter, not a module-level global.** `parseMetadata(text, maxBodyBytesForScan
   = DEFAULT_METADATA_SCAN_CAP_BYTES)`. Every call site that has a resolved per-vault
   value passes it explicitly (`MetadataCache`'s `scanCapBytes` field on the renderer
   side; a module-level `scanCapBytes` set from the `initialize` message on the utility-
   process side). Call sites that don't pass one — existing tests, anything not yet
   updated — keep the shipped default, so this is additive rather than a breaking
   signature change.

3. **Per-vault setting, not global.** `MetadataCache` is instantiated once per `App`
   but re-initialized on every vault open/switch, reading that vault's own
   `.geode/app.json` each time (`AppSettings.metadataScanCapBytes`, alongside existing
   settings like `cssTheme`). Different vaults reasonably want different values (a
   vault of long AI transcripts vs. a vault of short daily notes), matching how
   `daily-notes`/`bookmarks`/`app` config already scope per vault rather than globally.

4. **Threaded to the utility process at `initialize()` time, not live.** The utility
   process (`indexer-process.ts`) does its own independent `parseMetadata` pass and
   needs the same cap for the setting to have full effect. Since the main process
   (`main.ts`) already reads/writes `.geode/<name>.json` files directly for the
   `config-read`/`config-write` IPC handlers, it also reads `.geode/app.json` directly
   (no renderer round trip) right before spawning/initializing the indexer utility
   process for a vault, and passes the resolved value alongside `root`/`files`. A
   setting change made while a vault is already open takes effect immediately for the
   renderer's own re-parses (`MetadataCache.setScanCapBytes`), but the running utility
   process keeps its original value until the vault is reopened (which respawns it).
   Pushing a live update to an already-running utility process was judged unnecessary
   complexity for a setting whose main cost (OOM) only bites at initial vault scan.

5. **Validation lives in one place.** `resolveMetadataScanCapBytes` (pure, in
   `src/indexer/metadata-indexer.ts` — already shared across the renderer, main, and
   utility-process bundles) clamps to `[MIN_METADATA_SCAN_CAP_BYTES,
   MAX_METADATA_SCAN_CAP_BYTES]` and falls back to the default on invalid/missing
   input. Both the renderer (loading a saved setting, validating the Settings UI's
   input) and the main process (reading the raw file for the utility process) call the
   same function, so "valid" can't drift between the two.

6. **Settings UI: new "Advanced" tab.** No existing tab fit; added one following the
   existing `BUILTIN_TAB_IDS`/`activateTab`/`renderNav` pattern, with a new
   `addNumberInput` helper (clamped, validated) alongside the existing `addToggle`/
   `addDropdown`/`addTextInput`. Exposed in KB (1 KB = 1000 bytes) rather than raw
   bytes for a more legible "how big is too big" judgment call; stored internally in
   bytes to match `parseMetadata`'s unit.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Keep the hardcoded 300,000-byte constant | Zero new surface area | Users with more/less memory, or vaults that genuinely need in-note navigation on huge files, have no lever; the exact tradeoff this ADR exists to avoid hardcoding |
| Global (app-level) setting in `geode.json` | Simpler — one value, no per-vault threading to the utility process | Wrong scope: `MetadataCache` and the utility process are both per-vault-session; a global value can't reflect that one vault has huge transcripts and another doesn't |
| Push live updates to the running utility process on setting change | Fully live | Requires a new message type and re-triggering a partial re-index for already-parsed large files; the cap's cost only matters at initial scan, so the complexity wasn't justified |
| **Per-vault setting, threaded explicitly, applied at initialize() time (chosen)** | Matches existing per-vault config scope; validation centralized; additive signature change | Setting change on an already-open vault doesn't retroactively re-scan files the background indexer already parsed until the vault is reopened |

## Consequences

Files whose body exceeds the configured cap lose in-app heading/tag/link/list-item
navigation (headings pane, backlinks, unlinked mentions, outline) but keep frontmatter
and frontmatter-derived tags/aliases. This is a visible, documented tradeoff (surfaced
in the Settings UI's description text), not a silent data loss — no crash, no partial/
corrupt metadata, just an intentionally smaller metadata object for oversized notes.

The default (300,000 bytes) matches what was verified to resolve the originating OOM
(a vault of 878 files up to 1.6MB each) without affecting normal-sized notes, so
existing users see no behavior change unless they open a vault with unusually large
individual notes.

## Risks

- A user who sets the cap very low (near `MIN_METADATA_SCAN_CAP_BYTES`, 1000 bytes)
  will lose navigation for most non-trivial notes. This is deliberately allowed — the
  floor only rules out 0/negative (which would defeat the setting's purpose entirely),
  not "too aggressive."
- A user who sets the cap very high (near `MAX_METADATA_SCAN_CAP_BYTES`, ~1GB) can
  reintroduce the original OOM risk for sufficiently extreme vaults. This is the user's
  explicit choice, matching the brief's framing ("a very large number should
  effectively disable it — that's fine").
- The utility-process cap only updates on vault reopen. If this proves confusing in
  practice, a future iteration could push a live update message and have the utility
  process re-parse already-indexed large files whose cached metadata differs from what
  the new cap would produce.
