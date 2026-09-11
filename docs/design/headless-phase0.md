# Geode Headless: Phase 0 feasibility evidence

Date: 2026-09-11. Scope: extraction and database transaction feasibility only.
This is engineering evidence, not a shipping announcement or roadmap commitment.

## Result and boundaries

Geode's existing metadata parser and desktop link resolver can run in a fresh
Node process with injected file lookup and no DOM, Electron, or host registry.
The implementation is shared with desktop through re-exports and a thin resolver
wrapper. Conventional PostgreSQL supports the proposed serialized per-vault
publication and idempotent receipts in a disposable transaction fixture.

This is not yet a published engine package, general filesystem provider, cloud
service, SDK, CLI, or MCP server. No Blob resources, deployment, synchronization,
or paid infrastructure are required by these proofs. The Node fixture and SQL
fixture are independent; a complete parse/upload/catalog commit is not proven.

## Extraction dependency map

| Area | Observed dependency or contract | Phase 0 action / next boundary |
| --- | --- | --- |
| `src/wiki/metadata.ts` | `yaml`, pure comment masking, indexer scan-cap constant, portable metadata types | Moved the actual parser and source-position helpers here without semantic changes |
| `src/wiki/link-resolution.ts` | Injected `getFileByPath`, sorted basename and alias maps | Moved actual desktop algorithm; generic result type avoids desktop `TFile` |
| `src/wiki/types.ts` | Plain metadata interfaces | Moved from renderer; original import paths re-export the same types |
| `src/renderer/comments/model.ts` | `@lezer/markdown` plus pure frontmatter helpers | Remains a portable implementation under the renderer directory; packaging can move it later |
| `src/renderer/api/frontmatter.ts` | Type-only dependency on wiki types | No runtime host/DOM dependency; retained as parser dependency |
| `src/indexer/metadata-indexer.ts` | Portable types, Node `Buffer` in snapshot chunking, injected reconcile store | Parser imports only scan-cap constant; split constants/index contracts before publishing a package |
| `src/renderer/metadata-cache.ts` | `Vault`, events, canvas projection, performance hooks, optional `window.geode` indexer integration | Still desktop lifecycle/cache; calls extracted parser and resolver |
| `src/renderer/vault.ts` | Default `getHostServices()`, broad host services, manifest reconciliation | Not instantiated or mocked in Node proof; a general folder provider is subsequent work |
| `src/renderer/host/contracts.ts` | Storage vocabulary mixed with windows, plugins and runtime capabilities | Narrow engine contracts must not inherit the whole host interface |
| `src/indexer/indexer-process.ts` | `process.parentPort`, filesystem, SQLite store | Electron utility-process orchestration stays outside engine |
| `src/main/metadata-cache-store.ts` | `node:sqlite`, filesystem, desktop `.geode` index path | Rebuildable local index precedent; not a cloud catalog |
| `src/renderer/views/search-view.ts` | Pure term matching alongside view/icon imports | Extract query primitives when local engine adds search |
| `src/renderer/rename.ts` | Pure textual rewrite plus basename validation | Useful regression fixtures; not identity-aware cloud rename planning |

The executable proof audits esbuild's complete input graph against an explicit
source allowlist, in addition to checking absent `window`, `document`, and
`process.versions.electron` at runtime. The graph contains the five runtime
modules above (`wiki/metadata`, `wiki/link-resolution`, comment model,
frontmatter helpers, metadata-indexer) plus package dependencies. Unexpected
source dependencies fail even if a bundler could tree-shake them away.
`tsconfig.headless.json` independently compiles with ES2022 and Node types,
without the DOM library. A YAML CommonJS-to-ESM bundling interop shim supplies
Node's `createRequire`; it is not a browser or Electron stub.

## Provider proof

The internal resolver contract consists of three read-only inputs: file lookup
by path, basename candidates, and alias candidates. The caller owns index
freshness and lexical candidate ordering. Desktop supplies its existing maps.
The Node proof uses two synthetic Markdown files and one byte attachment in a
temporary folder, parses bytes read through Node, constructs fixture indices,
then resolves a heading link, an alias, an attachment, and a missing target.
It removes only its own generated directory on exit.

This fixture provider intentionally accepts only fixed known paths. It does not
claim traversal protection, arbitrary symlink handling, path normalization,
collision detection, storage mutations, revision pinning, or index persistence.
Those belong in the real provider contract and its tests.

## Characterized semantics and gaps

Five additional characterization cases first ran against the unchanged desktop
implementation (alongside 79 existing metadata-cache tests). They remain green
through the extraction; the full existing suite supplies broader compatibility
coverage. The new Node-process test supplies independent loading evidence.

| Input / condition | Current observed behavior | Follow-up needed |
| --- | --- | --- |
| YAML alias/tag arrays, embeds, task block IDs | Parsed; CRLF wikilink source offsets preserve exact spans | Retain fixtures |
| LF headings | Parsed | Retain |
| CRLF headings | Heading array is empty for the fixture | Fix with explicit desktop compatibility decision |
| Backtick inline code and fenced code | Wikilinks masked | Expand edge corpus before strict mode |
| Tilde code fences | Section scanner sees code, but wikilink extraction includes fenced links | Reconcile masking rules |
| Inline Markdown `[local](Target.md)` | Not added to `links` | Implement local Markdown reference extraction |
| Malformed YAML | No frontmatter; treated as body, no structured diagnostic | Add diagnostics without silently rewriting content |
| Body above scan cap | Frontmatter retained, body metadata omitted | Expose partial coverage; existing cap measures JS string length despite “Bytes” name |
| Exact, source-folder, basename, alias lookup | Existing priority preserved | Define strict ambiguity result separately |
| Equal-length basename candidates | Existing lexical ordering breaks tie | Avoid silent tie-breaking in future agent strict mode |
| Missing heading suffix | File still resolves; suffix existence not checked | Distinguish missing file/subpath |
| `../Target` | Not normalized; fixture returns no result | Define relative-path semantics |

These gaps were already present and are intentionally recorded rather than
changed during extraction. Existing comment-metadata tests continue to cover
the real comment masker; the five new fixtures are not a complete Markdown
conformance suite. The current rename regex does not establish safe resolved
identity, code exclusion, or relative-link rewrite correctness.

## PostgreSQL transaction proof

`scripts/headless-postgres-proof.sql` creates four fixture tables in a unique
schema: a singleton vault sequence, note catalog, derived search projection, and
mutation receipts. The runner uses standard externally configured `PG*`
connection settings and `psql`; no database client dependency is added.

Publication locks the vault row, checks for an existing receipt, conditionally
increments the supplied base sequence, writes all changes to catalog/index, then
inserts a durable receipt in the same transaction. Receipt identity hashes the
base plus JSONB-normalized changes. A duplicate checks its receipt after waiting
for the winning transaction, before treating its original base as stale.

Six scenario groups are asserted:

1. Initial publication, identical retry, and conflicting ID reuse.
2. Stale base rejects without advancing sequence or publishing a note.
3. Concurrent distinct IDs at the same base: exactly one winner, no loser receipt or note.
4. Concurrent same ID and payload: waiter returns exactly the winner's receipt, sequence advances once.
5. Concurrent same ID and different payload: waiter rejects, winner's bytes remain intact.
6. Failure after two-file writes and receipt insertion: catalog, index, sequence and receipts equal the prior snapshot; a subsequent two-file retry publishes both entries in both tables.

For all three concurrent groups, one transaction remains open while another
connection requests publication. The runner verifies the waiter is blocked in
`pg_stat_activity` with `wait_event_type = 'Lock'`, and a third connection sees
only the prior committed snapshot. It then releases the first transaction.
Assertions do not depend on assuming a delay implies concurrency. Bounded
timeouts fail visibly when a lock wait cannot be observed.

The fixture is one vault in a disposable schema, not a production migration.
It does not implement object uploads, revisions, tombstones, rename planning,
authorization, multi-tenant isolation, garbage collection, or cryptographic
content verification. The search projection stores content to prove atomic
visibility; it is not the proposed search engine. Managed PostgreSQL vendor,
network latency, connection pooling and costs remain unmeasured. Blob/database
crash recovery still requires separate fault-injection work.

## Reproduce

From a checkout with dependencies installed:

```sh
npm run typecheck
npm run proof:headless
npm test
```

The Node proof also runs in the normal unit suite. The separate headless command
additionally runs the DOM-free TypeScript configuration.

For the database proof, configure `PGHOST`, `PGPORT`, `PGUSER`, and `PGDATABASE`
for a disposable local PostgreSQL cluster. Use a role permitted to create a
schema and inspect its own sessions. Supply credentials through normal libpq
configuration; do not put passwords in command arguments. `PSQL` optionally
selects the installed executable.

```sh
npm run proof:headless:postgres
```

The runner creates a randomized `geode_phase0_*` schema and drops exactly that
schema in `finally`, including failed assertions. It does not alter `public` or
start/stop a database server. Interrupted process termination may require manual
cleanup of that run's schema. Tests use synthetic note content only.

## Verification evidence

- Node v25.9.0: fresh process proof passed; 2 notes, 3 resolved references and missing target verified.
- `npm run typecheck` and `npm run proof:headless`: passed, including DOM-free compile.
- PostgreSQL 18.4: 6 scenario groups passed, 3 lock waits observed, two-file rollback verified, final sequence 5.
- Initial restricted full-suite attempt: 2,045 tests passed; one existing socket-listen test hit sandbox `EPERM`. Re-run with socket/Electron execution permission required; no test was skipped or modified.
- Full permission-enabled `npm test`: exit 0. Unit summary: `Test Files 161 passed (161)` / `Tests 2046 passed (2046)`. Build passed. Electron summary: `1 flaky`, `1 skipped`, `231 passed (9.9m)`.
- Flaky on its first attempt, passing on the configured retry: `bases-kanban-interaction.spec.ts` — “a plugin Bases view can write the vault: drag, quick-add, open and cover images”; the initial drag did not rewrite frontmatter within 10 seconds. No test code or retry policy changed.
- Existing optional skip: `companion-plugin-integration.spec.ts` — “real Agent Threads retains one companion across tab closure, plugin reload, and two relaunches”; requires `GEODE_AGENT_THREADS_DIST`, which was not configured. This unrelated optional integration was not exercised.
- No visual behavior changed. Existing Electron regressions cover desktop parsing, frontmatter, comments, backlinks and primary smoke flows; generated screenshot changes from that suite were restored and are not part of this extraction.

## Subsequent build breakdown

This evidence supports proceeding with the approved approach, but does not
authorize or implement the subsequent phases. Suggested reviewable increments:

1. **Core boundary and semantics:** finish moving pure comment/frontmatter/index constants to portable ownership; define paths, ambiguity, subpath diagnostics and coverage. Tests must distinguish desktop compatibility from agent strict mode.
2. **Folder provider and local wiki:** implement validated storage operations with injected index/event contracts, extract search, and prove local CRUD/search/backlinks in fresh Node processes. Preserve desktop wrapper tests.
3. **Catalog contract and cloud vertical slice:** convert the PostgreSQL fixture into reviewed multi-vault schema/API transactions, add immutable bytes and upload validation, and prove a second VM restores acknowledged content. Select database hosting with measured limits/cost.
4. **Structural operations and recovery:** identity-aware rename changesets, index dependency updates, revision history, restore and rebuild; test upload/catalog crash boundaries and orphan races.
5. **Agent interfaces and pilot:** SDK, CLI, MCP, bounded import/export and diagnostics over the same services, then representative handoffs and contention/latency measurements.

The largest remaining work is contract hardening and safe structural mutation,
not removal of Electron from the parser. Full package extraction and cloud
operational feasibility remain separate acceptance milestones.
