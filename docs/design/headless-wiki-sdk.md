# The headless wiki SDK — public surface

Date: 2026-09-19. Scope: the in-repo SDK entry point only.

This is the contract ledger for `src/wiki/index.ts`. It says what a consumer may
depend on, what it may **not**, and why for each exclusion. Session semantics —
why the SDK hands out a session rather than a snapshot — are decided in
[ADR 0023](../adr/0023-wiki-sdk-session-semantics.md); the read and write
behaviour underneath is [ADR 0019](../adr/0019-readonly-local-wiki-snapshot.md)
and [ADR 0020](../adr/0020-write-capable-local-wiki-provider.md), unchanged.

**This is not published.** There is no registry publication, no external
distribution, no CLI and no MCP server. `package.json`'s export map names
`./wiki` and resolves it to TypeScript source, because every in-repo consumer
bundles from source with esbuild exactly as the existing proof scripts do. The
desktop app entry stays on `main`, which is what Electron reads; the export map
does not disturb it.

## Entry point

```ts
import { openWikiSession } from "geode/wiki";           // in-repo
// or, from inside this repo's own scripts and tests:
import { openWikiSession } from "../src/wiki/index";

const opened = await openWikiSession("/path/to/vault");
if (opened.status !== "ok") throw new Error(opened.error.code);
const session = opened.session;

await session.createNote("Notes/N.md", "# N\n\n[[Target]]\n");
session.backlinks("Target.md");   // already contains Notes/N.md
```

At runtime the module exports exactly two values: `openWikiSession` and
`DEFAULT_WIKI_LIMITS`. Everything else it exports is a type, erased at runtime.
`tests/unit/wiki-sdk.test.ts` asserts that list, so a leaked internal shows up
as a test failure rather than as somebody's dependency.

## Public — the session

`openWikiSession(rootPath, options?)` → `{ status: "ok", session }` or
`{ status: "error", error: CaptureError }`. It reports a capture failure; it
does not throw.

`options` is `{ limits?: Partial<WikiLimits> }` and nothing else. The opener
forwards that one field explicitly rather than spreading the object, so the
provider's internal adapter seams cannot be reached through an untrusted options
bag.

| Method | Answers |
| --- | --- |
| `info()` | Coverage and provenance of the current view: `discoveryComplete`, `noteContentComplete`, `aliasCoverageComplete`, diagnostics, limits, exclusion policy, parser limitations |
| `listFiles()` | Every retained note and attachment as `{ path, kind }`, sorted by path. Never bodies |
| `readNote(path)` | `ok` with text, metadata, diagnostics and per-note parser coverage; or `invalid` / `absent` / `unavailable` |
| `search(query, limit?)` | A bounded, ASCII-folded **literal** scan over note bodies, reporting `truncated` and `complete` |
| `resolveLink(fromPath, target)` | `resolved` / `ambiguous` / `missing` / `invalid` / `external` / `unavailable`, with candidates and a subpath result. Agent-strict policy: ambiguity is reported, never tie-broken |
| `outgoingLinks(path)` | References this note makes, each carrying its own resolution |
| `backlinks(path)` | References that resolve to this note |
| `createNote(path, text)` | `WriteResult`, with a distinct status per refusal |
| `updateNote(path, text)` | `WriteResult` |
| `deleteNote(path)` | `WriteResult` |
| `refresh()` | Re-read the folder. The only way to observe an external change |

**Read-after-write is guaranteed.** Every read is served from the provider's
current view at the moment you call it, so a write made through this session is
visible to the very next read — no refresh, no re-open. There is no method that
hands out the view itself, which is what makes the stale-handle bug
unrepresentable rather than merely discouraged. See ADR 0023.

**A sequence of reads is not a transaction**, and nothing outside this process
is observed until `refresh()`. There is no filesystem watcher.

### Public types

- Metadata vocabulary, from `types.ts`: `CachedMetadata`, `LinkCache`,
  `TagCache`, `HeadingCache`, `SectionCache`, `ListItemCache`,
  `FootnoteRefCache`, `ReferenceLinkCache`, `Loc`, `Pos`. Public by necessity —
  they are the shape of `readNote(...).note.metadata`.
- Result vocabulary: `ReadNoteResult`, `SearchResult`, `Resolution`,
  `SubpathResult`, `ResolvedReference`, `GraphResult`, `ParserCoverage`,
  `Diagnostic`, `WriteResult`, `WriteStatus`, `CaptureError`, `RefreshError`,
  `RefreshResult`.
- Surface types declared or renamed here: `WikiSession`, `WikiSessionInfo`,
  `WikiFileEntry`, `WikiNote`, `WikiLimits`, `OpenWikiSessionOptions`,
  `OpenWikiSessionResult`, and the `DEFAULT_WIKI_LIMITS` value.

Four of those are boundary edits rather than pass-throughs:

| Surface name | Internal | Why the difference |
| --- | --- | --- |
| `WikiLimits` | `SnapshotLimits` | "Snapshot" is a word this surface deliberately does not use; leaving it in an option type reintroduces the concept |
| `DEFAULT_WIKI_LIMITS` | `DEFAULT_SNAPSHOT_LIMITS` | Same |
| `WikiNote` | `CapturedNote` | "Captured" is capture-pipeline vocabulary, and the capture pipeline is not public |
| `WikiFileEntry` | *(declared fresh)* | The internal `CapturedFile` carries an optional `text` and is documented in-source as "internal capture boundary, not a supported public SDK". `listFiles` never returns bodies, so the public type says so |

`WikiSessionInfo` is declared structurally rather than inferred from the
snapshot's `info` object, so a drift underneath is a compile error at the
boundary instead of a silent change to the public contract. That pin was
verified by temporarily adding a field and observing `tsc` fail.

## Not public — and why

Everything under `src/wiki/` not listed above is internal **by omission**. These
are the exclusions worth stating explicitly, because each one is a thing a
consumer might reasonably have expected to find.

### Two contracts that would contradict the public one

| Excluded | Reason |
| --- | --- |
| `search.ts` — `parseQuery`, `matchFileAgainstTerms`, `SearchTerm`, `SearchMatch` | This is the **desktop search view's operator query language** (`file:`, `tag:`, `-negation`, `/regex/`). ADR 0020 records that it is deliberately *not* converged with the snapshot's bounded literal scan: the two answer different questions and merging them is a design change to both. Exporting both would ship two different meanings of "search" under one surface. The SDK's `search` is the literal scan |
| `link-resolution.ts` — `resolveFirstLinkpathDest`, `LinkResolutionProvider` | The **desktop-compatibility** resolver, which silently tie-breaks an ambiguous basename by length and then lexical order. The SDK answers under agent-strict policy, which reports ambiguity instead. One SDK must not carry both answers to the same question |

Both absences are asserted by the proof's input-graph audit, so they cannot
return by accident.

### Parser and format internals

| Excluded | Reason |
| --- | --- |
| `constants.ts` — `FRONTMATTER_BLOCK_RE`, `FRONTMATTER_BLOCK_OPTIONAL_BODY_RE`, `FRONTMATTER_OPEN_RE`, `COMMENT_DELIMITER`, `MATH_BLOCK_DELIMITER`, `FRONTMATTER_FENCE`, `MaskedDelimiter` | File-format internals. Freezing a regex into a public contract freezes the parser's implementation with it |
| `constants.ts` — `commentSpanPattern` | Hands out a `/g` regex, whose `lastIndex` is caller-visible mutable state. The in-source comment already warns that a shared instance silently skips matches. Not a shape to publish |
| `constants.ts` — `DEFAULT_METADATA_SCAN_CAP_BYTES`, `MIN_*`, `MAX_*`, `resolveMetadataScanCapBytes` | Desktop **settings** plumbing for `.geode/app.json`'s `metadataScanCapBytes`, not engine vocabulary. The scan cap is still visible to a consumer where it matters: `info().parserBodyCapCodeUnits`, and the `parser-body-cap` diagnostic on an affected note |
| `metadata.ts` — `parseMetadata`, `maskCode`, `buildLineStarts`, `offsetToLoc` | A consumer receives parsed metadata from `readNote`. Exporting the parser invites callers to parse text the engine never captured, under cap semantics the engine owns, and then to disagree with it |
| `link-candidates.ts` — `selectLinkCandidates`, `normalizeWikiPath`, `CandidateProvider`, `CandidateSelection`, `LinkResolutionPolicy` | Documented in-source as "internal policies, not a public SDK". A second path normalizer in consumer hands is how two disagreeing definitions of a valid path begin. The engine already refuses a bad path with `invalid-path` |

### Adapter seams and the capture boundary

| Excluded | Reason |
| --- | --- |
| `local-filesystem.ts` — `WikiFileSystem`, `WikiReadHandle`, `nodeWikiFileSystem`, `captureLocalWikiFolder`, `OpenSnapshotOptions` | The in-source comment says what it is: a "narrow adapter seam for deterministic failure tests". Injecting a filesystem is how the repo's own tests simulate races; it is not a consumer capability |
| `folder-provider.ts` — `WikiWriteFileSystem`, `nodeWikiWriteFileSystem`, `openLocalWikiProvider`, `LocalWikiProvider`, `OpenProviderOptions` | Same seam on the write side, plus the provider itself — whose `snapshot()` is precisely the handle ADR 0023 exists to withhold |
| `snapshot.ts` — `createWikiSnapshot`, `WikiSnapshot`, `CapturedFile`, `CaptureInfo`, `SnapshotLimits` as a name, `DEFAULT_SNAPSHOT_LIMITS` as a name | `CapturedFile`'s own comment reads "Internal capture boundary, not a supported public SDK". `createWikiSnapshot` builds a detached view from adapter-owned bytes, which is the read-after-write footgun in constructor form |
| `local-filesystem.ts` — `openLocalWikiSnapshot` | Returns a bare snapshot. Safe only in a strictly read-only program; the SDK cannot know it is in one, so it must not offer the shape that is only conditionally safe |

### Adapter sinks

| Excluded | Reason |
| --- | --- |
| `contracts.ts` — `WikiIndexSink`, `IndexedNote` | An index seam for an adapter that owns its own storage. A consumer that needs the parsed note already has `readNote`; a second delivery path for the same data is redundant surface |
| `contracts.ts` — `WikiEventSink`, `WikiChangeEvent` | There is no filesystem watcher, so the **only** events that can fire are ones the caller itself caused — and it already has that outcome in the returned `WriteResult`. Surface with no information in it. This becomes worth revisiting the moment a watcher exists; until then it is noise |

### Cloud catalog

| Excluded | Reason |
| --- | --- |
| `catalog-contract.ts`, `catalog-materialize.ts` | The transactional multi-vault publish/restore contract ([ADR 0022](../adr/0022-transactional-multi-vault-catalog-contract.md)), with a PostgreSQL reference adapter under `src/catalog/` still evolving alongside it. A different concern from an agent's local-vault interface, and not something to freeze into a consumer contract in the same increment that creates one |
| `query-projection.ts` | A **test oracle**: it exists to state the equality that a VM-A publish and a VM-B restore must satisfy. It is not a query API |

## Deferred, and named rather than silently dropped

These were considered and left out of phase 1 on purpose. Recording them means a
later increment adds them by decision rather than rediscovering them by accident:

- **Offset → line/column.** `search()` hits and every `Loc` carry character
  offsets. `offsetToLoc` + `buildLineStarts` would turn an offset into a
  line/column pair, which a consumer rendering "line 42" plausibly wants. Left
  out because the concrete caller does not exist yet, and a helper added for a
  guessed consumer is harder to remove than to add.
- **A read-only session mode.** A caller that wants read-only today simply does
  not call the write methods. An enforced flag implies an enforcement boundary
  that has not been designed or tested, so it is not claimed.
- **Change events.** See above — worth adding when a filesystem watcher exists,
  not before.
- **Per-note content identity across capture.** Still last-writer-wins, recorded
  as follow-up by ADR 0020 and unchanged here.

## Proof

```sh
npm run proof:wiki-sdk      # DOM-free compile, then the fresh-Node SDK proof
npm run test:unit           # includes both the proof wrapper and the in-process pins
```

`scripts/wiki-sdk-proof.mts` imports **only** `src/wiki/index.ts` and, in a fresh
Node process with no `window`, no `document` and no Electron, opens a folder,
searches, reads a note with metadata, resolves a unique link, an **ambiguous**
one, a missing one and an alias, lists backlinks, and creates, updates and
deletes a note — asserting after each write that the next read already reflects
it. It also measures the module's runtime export list and the session's method
list, so a widened surface fails the proof.

`scripts/run-wiki-sdk-proof.mjs` audits esbuild's complete input graph as an
**exact** set, so a module that quietly disappears fails as loudly as one that
appears. Named boundary checks run first, so a crossing reports which boundary
was crossed. The audited graph is:

```
src/renderer/api/frontmatter.ts   src/wiki/index.ts
src/renderer/comments/model.ts    src/wiki/link-candidates.ts
src/wiki/constants.ts             src/wiki/local-filesystem.ts
src/wiki/folder-provider.ts       src/wiki/metadata.ts
                                  src/wiki/snapshot.ts
```

The audit was verified non-vacuous rather than assumed to be: adding a value
import of the forbidden `src/wiki/search.ts` to the SDK entry point made the
runner exit 1 with *"the desktop operator query language must not be in the SDK
graph: src/wiki/search.ts"*, and removing it returned the runner to exit 0.
