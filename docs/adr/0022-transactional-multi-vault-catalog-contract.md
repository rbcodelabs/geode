# ADR 0022 — Transactional multi-vault catalog contract

Status: Accepted (publish and restore)
Date: 2026-09-19 (publish side), amended 2026-09-19 (restore side)
Extends: [ADR 0019](0019-readonly-local-wiki-snapshot.md), [ADR 0020](0020-write-capable-local-wiki-provider.md).
Supersedes: the single-vault fixture `scripts/headless-postgres-proof.sql` as a
schema model. That fixture and its runner remain as Phase 0 evidence and are
unchanged.

## Context

### Target-specific amendment — 2026-09-20

The enforcement claims below describe the conventional PostgreSQL reference
adapter, which remains unchanged. The separate, throwaway Aurora DSQL/private
Blob feasibility spike does **not** inherit its triggers, foreign keys or
blocking-lock guarantees. It uses verified content-addressed note and asset
reads, upload-before-catalog ordering and bounded optimistic-concurrency retry.
Failed publications can leave orphan bytes; privileged or buggy direct writers
can violate integrity that PostgreSQL prevents. Two-process cloud restore and
SQL-conflict retry were observed, not production readiness or tenant isolation.
See [DSQL findings](../design/dsql-catalog-findings.md) for measured evidence,
weakened guarantees, the upload-race regression and remaining limits. The
portable contract and this reference adapter are not replaced by the spike.

ADR 0019 gave the portable engine a read-only view of a local folder; ADR 0020
added validated writes. Both stop at the local filesystem. Nothing downstream
of a write existed: no catalog, no remote bytes, no way for a second process to
obtain what a first process produced.

`docs/design/headless-phase0.md` proved, in a disposable transaction fixture,
that conventional PostgreSQL supports serialized publication with idempotent
receipts — for **one** vault, with note text only, and with no object storage.
Its "Subsequent build breakdown" item 3 names the next increment: *"convert the
PostgreSQL fixture into reviewed multi-vault schema/API transactions, add
immutable bytes and upload validation, and prove a second VM restores
acknowledged content."*

This ADR covers that item, minus its final sentence. It was first written at
the checkpoint the build package required before the restore side began, and is
amended here now that VM-B restore exists. Database hosting selection with
measured limits and cost remains explicitly out of scope and unauthorized.

## Decision

Add a portable catalog contract in `src/wiki/catalog-contract.ts` and a
PostgreSQL reference adapter in `src/catalog/`.

**The contract is portable and the adapter is not, and that separation is
audited rather than asserted.** `src/wiki/catalog-contract.ts` imports one
engine module (`./link-candidates`, for the path normalizer the engine already
owns) and one Node builtin (`node:crypto`, behind the injectable `Digest` seam,
exactly as `nodeWikiFileSystem` sits behind `WikiFileSystem`). It imports no
driver, no `pg`, and nothing from `src/catalog/`.
`scripts/run-catalog-contract-proof.mjs` bundles the contract's proof with
esbuild and asserts its complete input graph is exactly
`["src/wiki/catalog-contract.ts", "src/wiki/link-candidates.ts"]`. An
unexpected source dependency fails the audit even if a bundler could tree-shake
it away.

**Nothing here extends a host type.** `CatalogStore` has one method. The
restore port, `CatalogRestoreSource`, is a *second* interface rather than a
second method, for the same reason `WikiIndexSink` and `WikiEventSink` are two:
an implementer of one should not be forced to stub the other.

**Validation happens before the store is contacted.** `publish(store, request)`
validates first and returns without touching the adapter if anything is wrong,
so a malformed publication never reaches durable storage. The adapter is not a
second place where validation rules are re-derived; it accepts only a
`ValidatedPublication`. `restore(source, vaultId)` mirrors this: a vault id
that is not a portable identifier is refused without becoming a query.

**Bytes are content-addressed and immutable.** An attachment is published with
a caller-declared lowercase-hex SHA-256 address. The contract verifies the
address against the bytes; the *database* verifies it again rather than
trusting the client, because a content address that is only checked
client-side is a naming convention, not a guarantee. Stored objects are
insert-only, enforced by a `BEFORE UPDATE OR DELETE` row trigger *and* a
`BEFORE TRUNCATE` statement trigger — a row trigger does not fire on TRUNCATE,
and `TRUNCATE object, catalog_entry` satisfies the foreign key that refuses
`TRUNCATE object` on its own. So an address that ever meant one byte string
cannot come to mean another, and the bytes cannot be erased wholesale either.

That enforcement stops at owner privilege, and the ADR says so rather than
overclaiming: the adapter connects as the schema owner, so
`ALTER TABLE object DISABLE TRIGGER ALL` is available to a session that means
to use it. "Insert-only, enforced" is a guarantee against a buggy client, not
against a privileged one. Closing that gap needs a role model — a non-owner
role the adapter actually connects as — which this reference schema does not
have and which is recorded as follow-up rather than half-built.

**A publication is one transaction or nothing.** `publish_catalog` advances the
vault sequence, inserts every object, applies every catalog entry and records
the receipt in a single transaction. There is no partial publication and no
intermediate state a reader can observe.

### Refusal statuses

Every distinct rejection has its own name, mirroring ADR 0020's
`invalid-path` / `not-a-note` / `already-exists` pattern. A generic failure is
not acceptable, because a caller has to be able to tell "your bytes are too
big" from "your hash is wrong" from "you told me one content address means two
different things" without parsing prose.

Decided by the portable contract, without a database:

| Status | Meaning |
| --- | --- |
| `invalid-vault-id` | Not a portable identifier |
| `invalid-mutation-id` | Not a portable identifier |
| `invalid-sequence` | Not a non-negative safe integer |
| `empty-publication` | Nothing to publish; a no-op must not consume a sequence number |
| `invalid-path` | Absolute, drive-qualified, escaping, backslashed, NUL-bearing, unnormalized, dot-prefixed, or `node_modules` |
| `not-a-note` | A note entry whose path is not `.md` |
| `invalid-note-text` | A note's text contains a NUL. Paths were already screened for this; text was not, and a NUL reached the `::jsonb` cast and came back as an unnamed `store-failed` |
| `asset-is-a-note` | An asset entry whose path *is* `.md` |
| `duplicate-path` | Two entries in one publication claim the same path |
| `portability-collision` | Two entries fold onto the same NFC-lowercased identity |
| `oversize` | Exceeds `maxNoteBytes`, `maxAssetBytes` or `maxPublicationBytes`; the refusal names which |
| `entry-limit` | More entries than `maxPublicationEntries` |
| `unsupported-content-type` | Content type outside the allowlist |
| `invalid-content-address` | Not 64 lowercase hex characters, or not the SHA-256 of the supplied bytes |
| `duplicate-with-mismatched-bytes` | One content address declared for two different byte strings |

Decided only by the transaction:

| Status | Meaning |
| --- | --- |
| `conflict` | The base sequence is not the vault's current sequence; nothing was published |
| `mutation-id-reused` | This mutation id exists for this vault with a different payload digest |
| `duplicate-with-mismatched-bytes` | The store already holds different bytes at a declared content address |
| `invalid-content-address` | The store's own digest disagrees with the declared address |
| `store-failed` | The store refused for a reason this contract does not name |

`duplicate-with-mismatched-bytes` appears in both groups on purpose: it is one
invariant — an address means exactly one byte string — enforced within a
publication by the contract and across publications by the store.

### Ordering that is load-bearing

The cross-address duplicate check runs **before** per-asset digest
verification. Both refusals are true of a publication that declares one address
for two byte strings, and the immutability violation is the sharper diagnosis.
`tests/unit/catalog-contract.test.ts` pins that order so a later refactor
cannot silently downgrade it to `invalid-content-address`.

### Multi-vault semantics

`vault_id` is a first-class key on every table. A publication takes a row lock
on **its own vault only**, so:

- Two publications of the same vault serialize, and a waiting duplicate sees
  the winner's receipt before its own base is tested.
- Two publications of *different* vaults do not interact at all.
- Sequences are per vault.
- Mutation ids are scoped per vault, so two vaults may independently choose the
  same caller-supplied idempotency key.

The second bullet is the claim Phase 0 could not make, and it is proven by
observation rather than by timing: `scripts/catalog-publish-proof.mts` holds
one vault's publication transaction open, confirms a same-vault publication is
blocked in `pg_stat_activity` with `wait_event_type = 'Lock'`, and confirms a
different-vault publication *completes* meanwhile.

All six of Phase 0's scenario groups are re-asserted against this schema, and
three of them require contention to mean anything. The schema's claim that "a
waiting duplicate sees the winner's receipt before its base is tested" only
exists under contention, so the concurrent same-id groups are run under a held
lock on their own vault rather than approximated by sequential retries: a
concurrent identical duplicate must return the winner's receipt *verbatim* and
advance the sequence exactly once, and a concurrent duplicate with a changed
payload must be refused with `mutation-id-reused` while the winner's bytes
survive intact. Three lock waits are observed per run.

### Restore verifies; it does not trust

A restore is not a privileged read. `verifyRestoredVault` re-checks everything
the publish side checked — content addresses recomputed from the returned
bytes, paths re-validated against the same portability rules, content types
re-checked against the allowlist — before a single byte is written to disk.

That is worth stating plainly, because the obvious objection is that publish
already checked all of it. It did. Which is precisely why re-checking is
useful: the only failures this can catch are the ones that happened *after* a
successful publication — corruption, truncation, a partial read, an
out-of-band write, a store bug. Those are exactly the failures a restore would
otherwise launder into a vault the engine then treats as authoritative.

The adapter does I/O and the contract decides. `readVault` returns raw rows;
`restoreSource` hands them to `verifyRestoredVault`. A second adapter therefore
cannot invent its own refusal vocabulary, or quietly skip verification by
reasoning about its own read.

| Status | Meaning |
| --- | --- |
| `invalid-vault-id` | Not a portable identifier; refused before the store is contacted |
| `absent` | No such vault, or a vault with no entries |
| `invalid-sequence` | The stored sequence is not a positive safe integer |
| `entry-limit` | More entries than `maxEntries` |
| `invalid-path` / `not-a-note` / `asset-is-a-note` | As on the publish side, applied to stored paths |
| `duplicate-path` / `portability-collision` | As on the publish side, applied to stored paths |
| `unknown-entry-kind` | A stored `kind` that is neither `note` nor `attachment` |
| `incomplete-entry` | A note with no text, or an attachment missing its address or content type |
| `missing-object` | A catalog entry whose content address resolves to no bytes |
| `byte-length-mismatch` | The store's own recorded length disagrees with the bytes it returned |
| `oversize` | Exceeds `maxNoteBytes`, `maxAssetBytes` or `maxVaultBytes`; the refusal names which |
| `unsupported-content-type` | Content type outside the allowlist |
| `invalid-content-address` | Not 64 lowercase hex characters, or not the SHA-256 of the returned bytes |
| `duplicate-with-mismatched-bytes` | One address came back describing two different byte strings |
| `store-failed` | The store could not be reached, or failed for a reason this contract does not name |

`RestoreLimits` is separate from `CatalogLimits` rather than reused, because
the quantities differ: a vault accumulates across many publications, so
measuring one against `maxPublicationBytes` would refuse a legitimately large
vault that was published correctly in small pieces. Hence `maxVaultBytes`, and
a fourth `OversizeLimit` cause.

#### Ordering that is load-bearing, again

`byte-length-mismatch` is tested **before** the digest. A truncated read trips
both, and "the store's own metadata disagrees with the store's own bytes" is
the sharper diagnosis. `tests/unit/catalog-restore.test.ts` pins that order,
and also pins the fallback: with no recorded length to contradict, the digest
is what catches it.

### The restored vault is opened by the real engine

`materializeRestoredVault` writes a verified vault onto a folder, and VM B then
opens that folder with the ordinary `openLocalWikiProvider`. The reconstructed
snapshot therefore comes from the real capture and indexing path, not from a
restore-only index that might agree with the original for the wrong reasons.

### What "observed identical" means

Scoped, deliberately, to **query results**, and written down as an explicit
function — `src/wiki/query-projection.ts` — rather than left implicit in an
assertion. In scope: `listFiles`, `readNote` text and parsed metadata,
`resolve`, `outgoing`, `backlinks`, `search`.

Out of scope, and this is a decision rather than an oversight: everything on
`snapshot.info` describing the *capture* — `scanStartedAt`, `scanEndedAt`,
folder-walk `diagnostics`, `exclusionPolicy`, capture `limits`. A catalog
restore has no equivalent of a wall-clock folder walk, so those cannot be equal
and must not be asserted equal. Making them comparable would mean giving
`createWikiSnapshot` an injectable clock and splitting capture provenance from
vault content — a material design change, out of this package's scope.

The exclusion is bounded rather than open-ended: capture-derived facts that
genuinely change query answers travel *inside* the query results and are
compared — `Resolution.discoveryComplete`, `Resolution.aliasCoverageComplete`,
`SearchResult.complete`, and the graph `coverage` block. A restore that
silently lost discovery completeness fails, even though `info` is not compared.

### Two processes, sharing only the schema

`scripts/run-catalog-restore-proof.mjs` installs one disposable schema, runs VM
A to completion as its own OS process, confirms that process is gone
(`process.kill(pid, 0)` raising `ESRCH`), then runs VM B as a second
independent process and diffs the two projections. VM B receives the schema
name and nothing else — not VM A's snapshot, its vault directory, its stdout or
its projection. VM B independently re-confirms VM A's absence at the database,
by observing no remaining backend under the schema's application name.

The harness sees both projections, because a diff oracle has to. Neither child
sees the other's.

## What this ADR does NOT cover

Explicitly absent, and unauthorized: synchronization in either direction,
any external document-store integration, hosted or managed database selection,
identity-aware rename, revision history, tombstones, garbage collection,
authorization, multi-tenant isolation beyond the `vault_id` key, orphan-race
handling, and any SDK, CLI or MCP surface.

The schema is a **reviewed reference schema, not a production migration**:
there is no migration tool and no schema-version table. The adapter is a
reference client, not a production one: one `psql` process per query, no
pooling, no retry policy, no observability. Connection settings come from
standard `PG*` libpq environment variables and no password is ever placed in a
command argument.

Note text is stored as text in `catalog_entry`; only attachments are
content-addressed. Extending content addressing to note bytes is a
deliberate non-decision here.

Restore is whole-vault and read-only. There is no incremental restore, no
restore-at-sequence, no streaming, and no repair: when the contract refuses a
restore, the planted or corrupted rows stay exactly where they were. A restore
is a checkpoint, not a repair tool.

`duplicate-with-mismatched-bytes` and `missing-object` are unreachable through
this particular schema — the `object` primary key on
`(vault_id, content_address)` prevents the first, and the catalog entry's
foreign key prevents the second. That is the schema working, not the refusals
being untested: both are exercised against raw vault fixtures in the contract's
own proof and unit tests, and the VM-B proof says so where it does it rather
than implying a database observation it did not make.

## Consequences

- `tests/unit/catalog-contract.test.ts` covers the publish accepting path,
  digest stability, UTF-8 byte accounting, and every refusal including the
  check order. `tests/unit/catalog-restore.test.ts` covers the restore
  accepting path, every restore refusal, the truncation ordering, and the
  materializer's exact byte round-trip and containment refusal.
  `tests/unit/query-projection.test.ts` covers the projection's stability, what
  it compares, and what it deliberately does not.
  `tests/unit/catalog-postgres-store.test.ts` covers the adapter's failure
  classification, SQL literal escaping, hex byte encoding and both injection
  flags without a database. `tests/unit/catalog-contract-node.test.ts` runs the
  portable proof in a fresh Node process and asserts the audited input graph.
- `scripts/catalog-publish-proof.mts` (npm `proof:catalog:postgres`) is the
  VM-A publish proof: it builds a synthetic vault on disk, reads it back
  through the real `openLocalWikiProvider`, and publishes it — wikilinks,
  aliases, two content types and two attachments sharing one content address
  included — into a schema it drops in `finally` when it owns one.
- `npm run proof:catalog:restore` is the two-process harness described above.
  Its input-graph audit is non-vacuous: adding a forbidden import to VM B fails
  it with `vm-b: unexpected runtime dependency: src/wiki/search.ts`.
- `publish_catalog` gained a second injection flag, `p_fail_before_receipt`,
  which dies after the sequence, objects and catalog entries are written and
  before the receipt exists. VM B uses it to show that window leaves nothing
  behind and does not burn the mutation id. The eighth argument is emitted only
  when set, so ordinary generated SQL is unchanged.
- The portable engine gained a catalog vocabulary — now in both directions —
  without gaining a database dependency, which is the property the whole
  extraction depends on.
