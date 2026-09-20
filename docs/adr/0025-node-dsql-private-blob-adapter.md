# ADR 0025 — Node DSQL/private Blob adapter, preview-only verification

Status: Accepted implementation direction; bounded preview verification passed
Date: 2026-09-20
Extends: [ADR 0022](0022-transactional-multi-vault-catalog-contract.md)

## Context

The portable catalog contract already describes publication, receipts and
verified restore. Its conventional PostgreSQL adapter uses database features
that Aurora DSQL does not provide. The separate DSQL feasibility spike showed
that Vercel preview OIDC can reach an attached DSQL cluster without an AWS login,
and that private Blob can carry content-addressed bytes across process restarts.
That throwaway `psql`/text-SQL harness is not a reusable runtime adapter.

The approved next increment is reusable Node adapter code and bounded synthetic
preview verification. It does not authorize production installation, sync,
desktop UI changes, existing application-schema changes, new paid infrastructure,
or release. Production-quality is an implementation target, not an operational
readiness claim.

## Decision

Add a separate `geode/catalog/cloud` Node entry point. Preserve both portable
`CatalogStore`/`CatalogRestoreSource` interfaces, the wiki input graph, and the
existing `geode/catalog` PostgreSQL façade.

Use pinned `pg`, `@aws-sdk/dsql-signer`, `@vercel/functions` and `@vercel/blob`.
SQL values are driver parameters. Only validated schema identifiers and fixed
statement structure enter SQL text. Runtime credentials select a schema-scoped
database role, never the database `admin` user. New physical connections obtain
OIDC-backed AWS credentials and a fresh DSQL connect token. Pools have explicit
connection, query, idle and lifetime bounds, verified TLS, and at most two
connections per configured pool.

Reuse the spike's four-table DSQL-compatible model. Publish bytes before opening
the metadata write transaction, then recheck receipts and base sequence in its
fresh snapshot. Batch parameterized metadata writes. Retry recognized OCC or
uniqueness conflicts from a new transaction with a bounded attempt count; retain
the existing portable refusal vocabulary. A concurrent exclusive-create loser
is successful only after rereading and verifying identical bytes.

Require explicit publication, restore, metadata and object-store limits. Bound
metadata returned by SQL before the driver allocates large text/row results;
check all recorded lengths and the aggregate restore limit before fetching any
object. Private Blob reads are authenticated, uncached, streamed under a byte
ceiling, and digest-verified for notes and assets. Stable requested keys are
checked, never silently replaced by an assigned pathname.

Provisioning and recovery remain outside the runtime façade. Preview tooling
pins the existing attachment identities and persists an exact, owner-only,
fsynced inventory before generating deployable code. Cleanup acts only on that
inventory and must be explicitly run, including after interruption.

## Options considered

| Option | Benefit | Cost / reason not selected |
|---|---|---|
| Keep the throwaway spike harness | Least additional implementation | Insufficient reusable credential lifecycle, recovery and observability |
| Separate Node DSQL/private Blob adapter | Preserves portable contracts and the approved hosting direction | Application-level integrity, cross-service failure recovery and provider-specific code |
| Managed conventional PostgreSQL | Stronger FK/trigger enforcement | Changes the selected hosting and infrastructure scope |
| Add sync or application integration now | Earlier integration feedback | Adds lifecycle and security assumptions before the storage boundary is verified |

## Consequences and security boundary

- No DSQL foreign keys or triggers enforce object immutability. A privileged or
  buggy direct writer can corrupt metadata or remove bytes. Verified reads detect
  many contradictions; they do not prevent privileged mutation.
- Blob and DSQL do not share a transaction. Failed publication can leave orphan
  bytes, but no receipt is returned for the failed metadata transaction. There is
  no general retention or garbage-collection service in this increment.
- A schema-scoped SQL role is not IAM isolation. The attached project's OIDC
  principal may also be authorized to obtain an admin token. Code constrained to
  a scoped SQL connection is not equivalent to an independently least-privileged
  workload identity. A synthetic denial test proves only that SQL connection's
  grants, not isolation from a compromised project runtime.
- Separate schemas do not isolate shared-cluster outages or resource pressure.
  Preview verification uses synthetic data only and an explicit cost/operation
  ceiling. Metrics and conservative retry reservations are not billing records.
- The maximum 24-hour preview retention window is an operator obligation, not a
  scheduled deletion guarantee. Verification is incomplete until exact cleanup
  and deployment removal are observed.

## Verification and reconsideration

The local PostgreSQL proof passed two independent process phases with equal
wiki projections, a 500-entry boundary, a cold-upload/SQL race, and rollback
after an actual SQL error. PostgreSQL reported `23505`; this does not establish
real DSQL `40001` behavior on its own. The subsequent protected-preview proof
did observe `40001` retry, concurrent cold-upload convergence, scoped SQL denial,
and equal wiki projections across independent publisher/restorer processes.
Its first restore failed on encoded HTTP length handling; a test-first fix and
second cloud run passed. Both attempts were cleaned twice and their exact
deployments removed. Full local gates and independent review passed; see the
implementation document for counts, limitations and the preserved failed result.

Revisit this decision if real DSQL rejects the supported boundary, scoped
permissions cannot meet the intended trust boundary, recovery cannot remove
exactly inventoried resources, or measured costs exceed the bounded preview
plan. Such changes require a revised scope, not silent infrastructure expansion.

See [implementation and operations](../design/node-dsql-cloud-adapter.md) for
configuration, reproducible local evidence and preview lifecycle requirements.
