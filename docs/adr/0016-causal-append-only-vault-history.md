# ADR-0016: Causal append-only vault history

**Date:** 2026-09-07
**Status:** Accepted for implementation; live beta gate pending

## Context

Not every transport can atomically compare and update mutable remote files. Offline desktop clients need durable retries and recovery without a clock-selected winner. Existing conditional providers retain their API. Local paths and device state cannot define shared remote identity.

## Decision

Add `append-only-history-v1` beside `conditional-mutation-v1` (omitted legacy discriminator preserves current behavior). Shared vaults use immutable versioned descriptors and UUIDs; each binding has a separate device UUID. Providers discover/create/verify roots, store verified immutable blobs, and publish immutable records. Geode owns causal reconciliation, conflicts, portable configuration, guarded local application, and scheduling. Drive continues to report `conditionalWrites:false`. No mutable global latest pointer or garbage collection.

Schema-1 records identify vault, record, operation, device, entity, namespace (`content` or `portable-config`), same-entity causal parents, immutable entity kind, deletion state, and location by parent folder identity/name. Live files carry an immutable physical blob reference with SHA-256 and size. Each record expresses full state. Stable folder IDs keep children attached across renames.

Heads are causal maxima, independent of arrival order or clocks. Multiple heads remain conflicts. Resolution names exactly displayed heads; unseen branches survive. Missing parents/blobs block affected components; malformed, cyclic, or contradictory history is quarantined. A differing payload under one record ID quarantines that ID and descendants. Folder tombstones never recursively remove live or unresolved children. New-device absence and scope exclusion never create tombstones. Rescans union with known history; reset never discards it.

Persist operation intent and physical-ID reservations before creation. Verify uploaded hash/size before publishing a record. Retry identical IDs; conflict responses require exact object verification. Cancellation does not prove rollback. Cursor advancement is atomic with the raw index and pending/quarantine state. Local application uses durable preimages, path/content guards, staged commits, main-process vault locking, and dirty-editor coordination. External filesystem writers remain outside Geode's lock.

Portable configuration uses separate logical typed exports, deterministic UUIDv5 entity IDs derived from vault/key, validated fields, and owning-service application. It never replicates raw private configuration or plugin data. Prior experimental state requires reconnect and preview.

Scans may carry physical `blobAvailability` evidence: `pending` blocks affected current heads until available; `corrupt` is irreversible for that physical ID. Evidence is persisted with history/cursor and never implies a logical deletion. A healthy new head referencing a different blob is not blocked by an obsolete ancestor's corrupt blob. Fresh-device portable defaults with no locally authored category fields adopt an existing remote category through the same guarded application; authored divergent configuration remains a conflict.

Portable categories are `editor.json` (readable line length, heading folding, line numbers, ribbon/status-bar visibility), `appearance.json` (light/dark theme, base font size, CSS theme), validated version-1 hotkey overrides, and Daily Notes enabled/folder/format/template. Theme and snippet assets have explicit mappings. Plugin enablement/data, secrets, workspace/session state, and other private settings are excluded.

## Options considered

| Option | Benefit | Cost / reason |
| --- | --- | --- |
| Mutable files with version preflight | Simple and directly browsable | Unsafe concurrent updates; rejected |
| Global conditional manifest | Compact snapshots | Requires unsupported compare-and-swap; rejected |
| Immutable blobs and causal records | Concurrent publication, independent reconstruction, retained recovery | History growth and more reconciliation work; selected |

## Consequences and risks

Stable folder identities simplify rename, but this implementation conservatively republishes descendant records when their derived paths change. Large folder renames therefore incur extra work and can conflict with independent child edits; parent-only publication is deferred. Retained remote history and local staging, journals, and preimages support recovery but grow without garbage collection. Stopping pending retries is not rollback; already-published records remain.

App-scoped discovery across independent authorizations, generated-ID retries, resumable upload durability, and a 24-hour soak must pass authenticated disposable tests before beta activation. Synthetic multi-client tests do not satisfy those live gates; the distributed Google provider stays disabled. Pending or corrupt state cannot appear up to date. No simultaneous external sync engine on beta vaults. Revisit if history cost prevents the 10,000-file/incremental target or live discovery/durability gates fail.
