# Read-only local wiki engine

Date: 2026-09-11. Acceptance specification for the user-approved next local
increment after [Phase 0](headless-phase0.md). This document defines an internal
engine contract, not a public SDK or a roadmap commitment for subsequent phases.
Architecture decision: [ADR-0019](../adr/0019-readonly-local-wiki-snapshot.md).

## Problem and outcome

An agent needs to inspect a folder of notes without a running desktop app and
without mistaking incomplete parsing or ambiguous names for authoritative facts.
Phase 0 established portable execution but used a fixed fixture provider. This
increment opens a real folder, captures bounded content in memory, and answers
metadata, literal search, link and backlink queries from that captured content.

The approved approach is a detached read-only snapshot with explicit diagnostics.
No writes, rename, watchers, persistent index, database, cloud, synchronization,
new dependency, public package, CLI or MCP interface are included. Attachment
identities are indexed for link resolution; attachment bytes are never loaded.
Desktop parser and resolver behavior stays compatible. No UI changes are needed.

## Internal contract

Implement a small Node entry point under `src/wiki/`, with pure query/index types
separate from the Node filesystem adapter. Exact names can follow repository
conventions; observable behavior below is the acceptance contract.

| Operation | Result |
| --- | --- |
| Open folder | Snapshot plus discovery diagnostics and effective limits, or a typed fatal error |
| List files | Sorted vault-relative identities and note/attachment classification |
| Read note / metadata | Captured text and parsed metadata, or typed absent/unavailable/invalid-path result |
| Search | Literal text matches in captured Markdown, sorted paths, bounded snippets, completeness/truncation flags |
| Resolve source + target | Resolved, ambiguous, missing, invalid, external/unsupported, or unavailable with candidates/reason |
| Outgoing references | Parsed wikilinks and embeds with source positions and resolution results |
| Backlinks | References with a uniquely identified destination file; preserve their subpath status |

Returned objects must not allow a caller to mutate internal content, metadata,
indices or subsequent query results. Use defensive copies or recursive freezing;
TypeScript `readonly` alone is insufficient. All post-open queries use memory,
including reads after the on-disk file changes or is removed. Reopening creates
a new snapshot. No incremental refresh API is necessary.

## Discovery, paths and limits

- Accept a caller-supplied folder root, resolve it once to a canonical absolute
  directory, and keep absolute paths internal. A caller-selected symlink root may
  canonicalize to its destination; symlinks discovered beneath it are excluded.
- File identities preserve discovered spelling, use `/` separators, and are
  case-sensitive. Markdown extension recognition is case-insensitive. Do not
  use the host filesystem's case-insensitive lookup to resolve query identities.
- Exclude any dot-prefixed path segment and `node_modules` directories. These
  defaults are fixed for this increment. Report the exclusion policy in snapshot
  metadata; ordinary policy exclusions do not generate one warning per entry.
- Skip all discovered symlinks, including internal links, broken links and loops,
  with a path-level diagnostic. Skip special files without opening them. Root
  failure is fatal; a descendant read/stat/list failure is a diagnostic that
  marks discovery or note coverage incomplete.
- Validate query paths before lookup. Reject absolute paths, drive/UNC paths,
  backslashes, NUL, empty identities and traversal above the root. Explicit link
  paths beginning `./` or `../` normalize relative to the source directory;
  a missing explicit relative target never falls back to a basename elsewhere.
  Path APIs use literal characters, with no percent decoding or URL conversion.
- Detect identities sharing `path.normalize('NFC').toLowerCase()` as portability
  collisions. Preserve every identity, emit the whole sorted collision group,
  and allow exact identity reads. Never collapse colliding notes or arbitrarily
  select one through normalized fallback. This is a defined normalization rule,
  not a claim to implement every filesystem's Unicode folding rules.
- Bound work before allocation/read. Defaults: 10,000 discovered eligible file
  entries, depth 32 below root, 2 MiB per Markdown file, 64 MiB total Markdown
  bytes. Validate configurable limits as positive safe integers. Count eligible
  attachments toward the entry cap. Stop/skip with explicit diagnostics at
  bounds; retain identities for known notes whose bytes cannot be loaded.
  Enumerate incrementally rather than reading an unbounded directory listing.
  An additional 50,000 visited-entry budget counts all directory entries,
  including hidden, special and directory entries. At most one further entry is
  observed to establish truncation. Root files are depth 1; depth 1 excludes root
  subdirectories. Capped membership follows filesystem enumeration order;
  returned query ordering is deterministic for the captured set.
- Read Markdown with a bounded read and fatal UTF-8 decoding. Oversize, invalid
  encoding or failed reads leave an unavailable identity; they do not become
  empty notes. Search cannot claim complete coverage of those notes.

Root containment uses path-component checks, not a string prefix. Validate each
visited component without following symlinks and check canonical containment
around reads. Open regular files without following final-component symlinks
where supported, compare file identity/stat observations before and after the
read, and reject observed replacements. Exercise deterministic race failures in
tests through the adapter boundary. Portable Node pathname APIs are not an OS
sandbox against a hostile process repeatedly replacing ancestor directories;
the supported environment is a user-selected local folder, not an attacker-
controlled concurrently mutating tree. Do not advertise stronger isolation.

## Snapshot semantics

The snapshot is a bounded scan assembled over time, not a filesystem-wide atomic
revision. Record scan start/end and `consistency: 'scan'`. Detect changes observed
within individual reads and omit their bytes with a diagnostic; do not retry
indefinitely or silently mix a file's old metadata with its new content. Each
successfully loaded note's search, metadata and references derive from exactly
the same captured text. Files added after enumeration can be absent until reopen.
Keep discovery completeness separate from parser capability/coverage.

## Resolution and partial parsing

Use a new strict resolver; keep Phase 0 `resolveFirstLinkpathDest` as desktop's
compatibility resolver. Strict resolution uses ordered tiers: exact root path
(literal then optional `.md`), exact source-folder path, basename, alias. Within
the first applicable tier return all candidates; more than one is ambiguous.
For basename/alias matching use NFC plus lowercase and stable path sorting.
Within each exact path tier, the literal identity wins over the optional `.md`
identity. Alias fallback reports `unavailable` when incomplete discovery or
frontmatter coverage prevents proving uniqueness/absence; candidates and
`aliasCoverageComplete` are retained. Exact file resolution remains available.
Explicit relative paths use only their normalized exact target. An empty file
part with `#Heading` or `#^block` refers to the source. Require an existing source
identity for resolution. Duplicate aliases must not create false duplicates for
one file. Do not strip extension names from attachment identities.

Split a target into file and optional heading/block selector. Validate heading
text by exact parsed heading text and blocks by parsed section/list-item IDs;
duplicate matches are ambiguous subpaths. Report file resolution independently
from `subpath: found | missing | ambiguous | unknown | none`. A missing heading
does not erase the file-level backlink; an ambiguous file does not create a
confirmed backlink. Unsupported selector syntax returns unknown/unsupported,
not a guessed interpretation. Scheme URLs are external; root-absolute/file URLs
are invalid local paths. There is no URL fetching.

Reuse the unchanged parser. Its result is characterized metadata, not complete
Markdown coverage. Every snapshot advertises `referenceSyntax: 'wikilinks'` and
the known parser limitations; backlink responses carry that coverage. The
diagnostic wrapper must make these existing gaps observable without quietly
fixing desktop semantics:

| Condition | Required interpretation |
| --- | --- |
| Inline/reference Markdown links | Unsupported for graph extraction; never claim complete Markdown backlinks |
| CRLF input | Heading coverage uncertain; missing heading is `unknown`, not confirmed absent |
| Setext headings | Unsupported; heading coverage uncertain rather than confirmed missing |
| Paragraph block IDs | Unsupported by current sections; block coverage uncertain |
| BOM-prefixed frontmatter | Captured bytes preserved, but parser frontmatter/alias coverage uncertain |
| Tilde fences | Reference extraction may include code; mark references/graph coverage uncertain |
| Malformed, unterminated or non-mapping frontmatter | Structured diagnostic; preserve parser output with uncertainty |
| Parser body scan cap exceeded | Frontmatter may be available; body-derived links/headings/blocks/tags incomplete |
| Unloaded target note | File identity can resolve; content/subpath coverage unavailable |
| Incomplete discovery | Missing file is missing from this snapshot, with incomplete-discovery flag |

The wrapper may conservatively diagnose unsupported syntax; it need not add a
second full Markdown parser. Existing parser scan cap is measured in JavaScript
string code units despite its legacy name. Use that exact unit when detecting
partial parsing and report it distinctly from filesystem byte limits. Position
offsets refer to captured original text in JavaScript code units.

## Search

Provide one bounded, case-insensitive literal query over captured Markdown text.
Trim the query; empty input returns no hits. Default maximum results is 50,
maximum accepted limit 500, maximum query length 1,024 code units. Return one
match per file with first-match offset and at most 250 code units of surrounding
line text. Define deterministic path ordering and a truncation flag. Match with
Unicode-aware case conversion consistently, retaining correct original offsets
even if lowercasing changes length. A simpler documented ASCII-only folding
contract is an acceptable implementation choice if Unicode offset correctness
cannot be preserved without new machinery; test the selected behavior.

No regex/query operators or desktop ranking parity are promised. Search scans
with ASCII-only case folding (`A`–`Z`); non-ASCII text matches literally. This
selects the allowed simple contract and preserves original code-unit offsets.
Search scans captured raw note text (including YAML/code/comment text).
The existing desktop helper has regex/operator semantics and comment stripping,
so do not import its view module or broaden this increment to extract it merely
for reuse. Missing metadata alone does not make raw-text search incomplete;
unloaded notes and incomplete discovery do.

## Acceptance evidence

Use synthetic fixtures only, created under a test-owned temporary folder. A fresh
Node process, with no Electron/window/document, must open nested notes containing
aliases, duplicate basenames, attachments, wikilinks, embeds, valid and broken
heading/block targets, and execute every internal query operation.

Required unit/integration cases:

1. Exact/root/relative/basename/alias precedence, ambiguity and duplicate alias
   deduplication; missing files and self-links; heading/block success and failure.
2. Backlinks preserve source spans and subpath failure, exclude unresolved file
   ambiguity, and disclose parser uncertainty across the graph.
3. CRLF, tilde fences, malformed/unterminated YAML, unsupported Markdown links,
   parser cap boundaries, invalid UTF-8, oversize and unreadable notes.
4. Traversal, Windows-style inputs, sibling-prefix escapes, nested hidden paths,
   symlink file/directory/loop/outside-root targets and special-file skipping.
5. Case and Unicode collision handling, constructed in-memory where the host
   filesystem cannot represent both spellings; stable sorted results.
6. Limits at exact boundaries, depth limits, bounded directory iteration and
   changing-file failure. No unbounded retry or allocation at a configured cap.
7. On-disk edits/deletes after open leave snapshot results unchanged; caller
   mutation of returned data cannot corrupt later queries.
8. Search empty/no-match/case/Unicode offsets/truncation and incomplete discovery.

Add the new proof to the DOM-free compile and input-graph audit. Run repository
typecheck, targeted tests, fresh-Node proof, build and required regression gates.
If desktop shared code changes, preserve its existing characterization tests and
run corresponding desktop coverage. Record exact scope/commands/results in this
increment's own evidence report. A proof demo is an internal script, not a CLI
product. No UI changes means no new UI screenshot requirement.

## Work breakdown and uncertainty

Three reviewable chunks: bounded folder capture; pure strict resolution/graph
and diagnostic wrapper; query proof and documentation. Initial engineering
estimate is roughly 3–6 engineer-days including adversarial tests and review,
not a calendar commitment. Filesystem race handling and faithful parser coverage
diagnostics dominate uncertainty. If portability needs a new dependency,
hostile-tree sandbox, parser rewrite, writes or persistent state, stop and revise
scope rather than treating it as an incidental implementation detail.
