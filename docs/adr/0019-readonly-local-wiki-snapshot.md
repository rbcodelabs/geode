# ADR-0019: Read-only local wiki snapshot

**Date:** 2026-09-11
**Status:** Accepted for the user-approved read-only local increment

## Context

Phase 0 proved existing parsing and compatibility resolution run in plain Node.
The next approved outcome is inspecting a real folder with metadata, search,
outgoing links and backlinks. The parser has known gaps and desktop resolution
chooses one ambiguous basename. Neither behavior is sufficient evidence for an
agent to claim a graph is complete. No public API, writes, persistence, cloud
deployment or new dependency is authorized by this increment.

## Decision

Capture a bounded folder scan as a detached in-memory snapshot. Serve every
query from the same captured bytes. Keep a narrow Node adapter separate from
pure index/query logic. Preserve exact file identities and attach discovery,
parsing and resolution diagnostics rather than discarding ambiguous evidence.
Use a new strict resolver beside the unchanged desktop compatibility resolver.
Provide bounded literal search instead of importing the desktop view or its
unbounded regex query semantics. Skip descendant symlinks and hidden paths.

Implementation selects ASCII-only case folding for search to preserve original
code-unit offsets, and a 50,000 visited-entry bound in addition to eligible-file
limits. Metadata reads defensively clone YAML containers because freezing a
Set/Map does not prevent mutation. Alias coverage is explicit when unreadable
notes could conceal competing aliases. Usage and reproduction commands:
[internal local wiki engine](../design/local-wiki-usage.md).

The [acceptance specification](../design/headless-local-readonly.md) defines
limits, containment, normalization, scan consistency and result completeness.
This records the supplied approved approach and bounded engineering decisions;
it does not approve subsequent writes, packaging or hosting.

## Options considered

| Option | Pros | Cons |
| --- | --- | --- |
| Detached bounded snapshot | Small Node boundary; reproducible queries; no lifecycle service | Memory cap; reopen required; scan is not globally atomic |
| Reuse desktop Vault and live metadata cache | Existing richer behavior and event flow | Broad host/lifecycle dependency; silent ambiguity and changing data |
| Persistent index with watcher | Larger vaults and low-cost repeated queries | Recovery, invalidation and event ordering expand scope before contracts are proven |

Choose the snapshot because it answers the approved inspection question with
the least lifecycle machinery. Persistent indexing can later consume these
contracts after a measured workload shows reopening is inadequate.

## Consequences

Queries remain stable after on-disk changes and cannot mutate the vault. A fresh
Node proof tests the real filesystem adapter rather than a desktop mock. Internal
strict semantics may intentionally differ from desktop's compatibility resolver;
the separate entry point makes that difference explicit and testable.

We give up live freshness, large-vault completeness beyond configured limits,
full Markdown graph coverage and desktop search syntax. Missing results describe
this snapshot, not necessarily current disk state. Attachment identities are
available but their contents are not loaded. The API remains internal until its
semantics have enough evidence for a public stability commitment.

## Risks

The riskiest assumption is that limited parser coverage still supplies useful
inspection when clearly diagnosed. Revise if the acceptance corpus shows users
need ordinary Markdown links or reliable CRLF subpaths before the engine is
useful; do not silently advertise completeness or rewrite shared semantics.

A local scan cannot promise a globally atomic filesystem revision, and portable
pathname checks are not an OS sandbox against hostile ancestor replacement.
Concurrent-change diagnostics address observable races in a trusted local tree.
A stronger security requirement would need a separate platform design. A
representative vault exceeding caps or reopen tolerances would justify measured
indexing work rather than automatically lifting all bounds.
