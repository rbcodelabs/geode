# ADR 0022 — Transactional multi-vault catalog contract

Status: Accepted (publish side only — see "Checkpoint")
Date: 2026-09-19
Extends: [ADR 0019](0019-readonly-local-wiki-snapshot.md), [ADR 0020](0020-write-capable-local-wiki-provider.md).
Supersedes: the single-vault fixture `scripts/headless-postgres-proof.sql` as a
schema model. That fixture and its runner remain as Phase 0 evidence and are
unchanged.

## Context

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

This ADR covers the first two thirds of that item, and is deliberately written
at the checkpoint the build package requires before the restore side begins.

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
restore port is a *second* interface rather than a second method, for the same
reason `WikiIndexSink` and `WikiEventSink` are two: an implementer of one
should not be forced to stub the other.

**Validation happens before the store is contacted.** `publish(store, request)`
validates first and returns without touching the adapter if anything is wrong,
so a malformed publication never reaches durable storage. The adapter is not a
second place where validation rules are re-derived; it accepts only a
`ValidatedPublication`.

**Bytes are content-addressed and immutable.** An attachment is published with
a caller-declared lowercase-hex SHA-256 address. The contract verifies the
address against the bytes; the *database* verifies it again rather than
trusting the client, because a content address that is only checked
client-side is a naming convention, not a guarantee. Stored objects are
insert-only, enforced by a `BEFORE UPDATE OR DELETE` trigger, so an address
that ever meant one byte string can never come to mean another.

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

## Checkpoint — what this ADR does NOT cover

**The restore side is declared, not implemented.** `CatalogRestoreSource` and
`RestoredVault` exist in the contract because the publish side's shape is only
reviewable against the read it has to satisfy. No adapter implements them.
There is no VM-B proof. That is the next increment's scope and this ADR does
not authorize it.

Also explicitly absent, and unauthorized: synchronization in either direction,
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

## Consequences

- `tests/unit/catalog-contract.test.ts` covers the accepting path, digest
  stability, UTF-8 byte accounting, and every refusal including the check
  order. `tests/unit/catalog-postgres-store.test.ts` covers the adapter's
  failure classification, SQL literal escaping and hex byte encoding without a
  database. `tests/unit/catalog-contract-node.test.ts` runs the portable proof
  in a fresh Node process and asserts the audited input graph.
- `scripts/catalog-publish-proof.mts` (npm `proof:catalog:postgres`) is the
  VM-A publish proof: it builds a synthetic vault on disk, reads it back
  through the real `openLocalWikiProvider`, and publishes it — wikilinks and a
  binary attachment included — into a randomly-named schema it drops in
  `finally`.
- The portable engine gained a catalog vocabulary without gaining a database
  dependency, which is the property the whole extraction depends on.
