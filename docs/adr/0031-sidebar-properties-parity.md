# ADR-0031: Reuse note buffers and metadata for sidebar parity

**Date:** 2026-10-14
**Status:** Accepted for the authorized overnight branch scope

## Context

Outgoing links and Properties panes are absent; a basic in-note PropertiesWidget and read-only Reading properties already exist. Metadata parsing, reference resolution, workspace/sidebar lifecycle and autosave already belong to established modules. Independent overnight packages must avoid divergent parsers, unsafe disk writes and broad public API changes. This ADR traces to Task `5d8e701c-4f02-4ead-8113-c29b3611bd7e`, Solution `523dc576-9b4d-4028-a8d3-e2e5f765d45a`, KR `c3b390f0-92a8-479c-b629-2b6745d577d5`.

## Decision

Build sibling sidebar views over existing metadata and live MarkdownView buffers. Keep outgoing matching pure and source-local, with cancellable projection rendering. Extract existing property controls into one shared component with a mutation adapter; never make the sidebar an independent disk writer when an editor buffer exists. Add a small persistent per-vault property registry behind the existing metadataTypeManager compatibility object, retaining its callable surface. Store display preference and exclusions in existing device-local per-vault configuration paths without extending the sync config schema in this package. The orchestrator selected this recommendation under explicit user authorization for reversible design decisions.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Existing metadata + live-buffer mutation adapters (selected) | Small integration, normal undo/autosave, one parser, independent views | Requires explicit stale snapshot guards and careful reuse of properties controls |
| Each view reads/writes Markdown through Vault | Easy isolated prototype | Can overwrite unsaved edits and race autosave; duplicates frontmatter behaviors |
| New central reactive note/properties database | Rich cross-surface updates | New architecture/dependencies and migration scope without a current requirement |

## Consequences

Implementation remains reviewable as outgoing view, property controls/registry, and property sidebar packages. A bounded internal note mutation method may be added where needed, guarded by MarkdownView read-only/vault-switch state, without exporting a new plugin API. Existing compatibility registry callers and Bases projections must continue working. New device-local preferences are not silently syncable; sync/export support remains a separately tracked gap. Candidate matching reads names/aliases of all targets, but only one source body. All properties counts use parsed frontmatter and count notes, not values.

## Risks

The riskiest assumption is that mutation adapters can guarantee their source snapshot still matches the live editor. Reject stale conversions rather than applying uncertain offsets. Properties must refuse malformed YAML and duplicate keys without destroying source; current helpers tolerate malformed YAML by replacing it, so the UI needs a strict preflight or improved pure helper. Global rename is inherently multi-file: require collision/conflict preflight, a review screen and progress/failure evidence; do not silently perform a partial or overwriting rename. Revisit a centralized document mutation layer only if the existing autosave/external-edit integration cannot enforce these invariants. Large-vault performance may justify a dedicated names/aliases index later, based on measured evidence.
