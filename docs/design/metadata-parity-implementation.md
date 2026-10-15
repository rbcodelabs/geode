# Shared metadata parity implementation

Authorized by the 2026-10-14 overnight parity instruction and Compass plan
8754c2d2-26fa-4695-b2d5-5ef973ae8489 revision
73e29b29-1fe8-495f-95b0-3d4d8f702e17. Task
8911c418-2720-4698-b916-438992e61601 → Solution
a3c803a7-3cdb-4e26-ae33-eb49c41985c4 → KR
c3b390f0-92a8-479c-b629-2b6745d577d5. The accepted architecture is
`docs/design/metadata-link-parity.md` at design commit `b0b44d2`.
This implementation is stacked on audit commit `0afe4ef`; the initial audit is a
historical baseline, not a claim about this branch's resulting behavior.

## Behavior

The shared wiki parser adds authored Markdown links/images, full/collapsed/shortcut
reference destinations, paragraph/list block records, footnote definition spans,
and frontmatter property wikilinks/frontmatter spans. It uses the already installed
Lezer Markdown grammar and YAML AST. Body references retain source order and exact
offsets, including CRLF input; external URLs never become phantom unresolved vault
paths. Public frontmatter references remain separate from body link arrays. Their
optional internal position covers the actual authored YAML scalar, including any
quotes, rather than a fabricated zero position. Property keys use dot-separated
mapping/sequence paths (for example `related.0`). Aliased YAML nodes are not walked.
Renderer graph counts, backlinks and headless outgoing queries share one projection.
The existing footnote scanner moves to a portable wiki module; renderer exports
retain their old names and behavior.

The literal pinned root-list contract gives every root the negative first-item
line. A list starting at line 2 uses `-2` for every root. A list starting at line 0
uses JavaScript `-0`, which JSON normalizes to `0`; it cannot be distinguished from
a child whose parent starts on line 0 by the numeric value alone. Actual built-in
bookmark/block-boundary and headless block-resolution consumers are tested against
that case and hydrated metadata. They use source spans and do not follow recursive
parent chains. No real third-party Tasks plugin fixture is installed in this repo;
its hierarchy behavior remains unverified. The `listItems` ledger rows remain
partial rather than promoting this ambiguity into a full compatibility claim.

## Cache upgrade

The metadata wire/cache schema advances to version 2. SQLite initialization reads
the previous version before stamping it and, in one transaction, clears only
`metadata_entries` on a mismatch. `hash_cache_entries`, note content and history are
preserved. The indexer then reparses unchanged timestamps because old derived stat
rows no longer exist. Browser/mobile fallback snapshots of version 1 are rejected
and reparsed through the same parser. The cache tests exercise both routes with
matching old timestamps, including rebuilt live resolution counts.

## Remaining limits

This is bounded syntax support, not a complete Markdown grammar claim.
`completeMarkdownGraph` remains false. The legacy `referenceSyntax: "wikilinks"`
field remains compatible; additive `additionalReferenceSyntax` identifies Markdown
and frontmatter-wikilink extraction. A reproduced expected-failure diagnostic keeps
nested bracket labels visible: the installed Lezer grammar eagerly treats an inner
bracket label as a shortcut reference, obscuring an enclosing authored link.
Snapshot diagnostics disclose this case and unscanned YAML aliases. Existing BOM,
heading/CRLF, oversized-body, and unsupported block-form uncertainty remains visible.

## Verification

Regression tests reproduce all nine initial audit gaps before their fixes. Additional
tests cover escaping, titles, encoded paths, comments/code, source order, property
separation, external URL exclusion, graph projections and cache upgrades. All nine
initial `.fails` diagnostics become ordinary regressions only after passing.
The new nested-label expected failure remains a diagnostic, never compatibility
evidence. SDK/node proof allowlists gain exactly the three new portable wiki modules;
existing renderer/process/provider boundary checks are retained.


## Independent review corrections

A newline-free 8,000-backtick input reproduced a 621 ms parse, exceeding the
500 ms regression bound. Metadata and footnote extraction now share a portable
bounded-pass code masker: fence scanning is linear, delimiter runs are indexed
by width within a paragraph, and masks cover nonoverlapping ranges. Direct tests
also cover many distinct unmatched widths. List block records are populated in
one pass rather than rescanning every item for every list section. Snapshot
`parserLimitations` names the remaining bounded cases and no longer says Markdown
links, tilde fences, or paragraph block records are universally unsupported.

## Delivery review: additional bounded syntax gaps

Independent review of the complete Metadata feature diff identified two more
unverified cases, retained as partial coverage rather than expanded during delivery:

- An escaped closing bracket in an authored label, such as `[a\]b](Note.md)`,
  resolves the destination but the current display label extraction truncates it
  at the first closing bracket. Do not claim exact display-text compatibility
  for that syntax.
- A linked image, such as `[![alt](image.png)](Note.md)`, exposes the outer link
  but the nested image is omitted from the embed projection. Do not claim complete
  image-reference extraction inside links.

These are follow-up parser gaps; the current package does not change their behavior.
The accepted metadata-link design is now included alongside this implementation
report so the design reference can be reviewed without another worktree.
