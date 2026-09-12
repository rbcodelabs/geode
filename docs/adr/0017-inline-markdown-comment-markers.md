# ADR-0017: Inline Markdown comment markers

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

## Addendum (2026-09-12): structural blocks

v1 read "protected Markdown syntax" as *any node that is not a paragraph*, which protected the entire span of every heading, list and table — so prose in the middle of a heading was rejected along with the `#`. That was broader than the rationale required. Range validation now distinguishes **opaque** nodes, which still protect their whole span (code, links, images, math, raw HTML, blockquotes, Obsidian comments, block IDs), from **transparent** containers, which are recursed into so that only their structural children are protected (`HeaderMark`, `ListMark`, `TaskMarker`, `TableDelimiter`). Headings, list items and table cells are therefore annotatable; blockquotes and code are not. A selection that straddles structural syntax is narrowed to the prose it covers rather than refused.

Widening the gate exposed two consequences the original decision did not anticipate:

- **Marker bytes begin with `<!--`**, which is CommonMark's HTML-block start condition. A marker on a line's first content position made Lezer parse the whole line as a comment block, breaking Live Preview's list and heading decorations — which read the raw editor document, not the stripped one. This already affected paragraphs before this change; it was simply never noticed, because nothing else reads the unstripped document. A marker-skipping block parser (`src/renderer/comments/marker-syntax.ts`) installed ahead of the default block parsers now keeps markers from starting a block.
- **Masking is not stripping.** The metadata cache masks markers to spaces to preserve offsets, which is correct for positions but corrupts extracted *text*. A commented heading yielded heading text with an embedded run of spaces, breaking `[[Note#Heading]]` resolution, heading bookmarks and transclusion. Consumers that extract text, as opposed to offsets, must excise marker spans rather than rely on the mask.

The release gate is unchanged in kind but broader in scope: rendering-invariance tests now cover each newly permitted block context, and a syntax-tree regression test asserts block structure is identical with and without a marker at a line's first content position.
