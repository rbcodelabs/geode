# ADR-0015: Inline Markdown comment markers

**Date:** 2026-09-04
**Status:** Accepted

## Context

Geode needs passage-anchored, threaded comments that remain local-first and travel with a note through rename, sync, backup, and external editing. A sidecar file makes ordinary file operations lose review context; embedding readable JSON would risk changing rendered Markdown and allow comment text to terminate an HTML comment.

## Decision

Store each thread in paired, versioned HTML comment markers around its anchor. The opening marker contains base64url-encoded JSON; the closing marker contains the same UUID. Live Preview and Reading view suppress valid markers, while Source mode exposes the bytes. Malformed markers are preserved and read-only. v1 prohibits nested or overlapping ranges and protected Markdown syntax.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Paired inline markers | Portable with the note; anchor moves with prose | Raw Source is noisier; external deletion can remove a thread |
| Vault sidecar database | Clean Markdown source | Rename/sync portability and recovery are harder |
| Text quotes plus offsets | No inline metadata | Anchors drift and require heuristic repair |

## Consequences

Comments need no account or service and remain durable anywhere the Markdown goes. Rendering, indexing, search, and word count must consistently suppress marker metadata. Deleting a complete marker pair deletes its thread; deleting only the anchored prose leaves a detached thread that can be reattached.

Closed-file mutations serialize per path and perform an uncached provider read immediately before writing. The current host contract has no atomic compare-and-swap primitive, so a residual read-to-write TOCTOU window remains; open editors continue through their normal conflict-aware save path.

## Risks

The riskiest assumption is that markers can surround the allowed plain-text ranges without changing Markdown semantics. Conservative range validation and rendering regression tests are the release gate.
