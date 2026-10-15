# ADR-0033: Consume whitespace runs once in metadata Markdown parsing

**Date:** 2026-10-14
**Status:** Accepted within the authorized overnight parity scope

## Context

Shared Markdown metadata extraction introduced synchronous quadratic work in the
installed Lezer parser: trailing spaces take approximately68/377/1552/7047ms at
10k/20k/40k/80k characters, versus less than1ms in baseline metadata. Normal prose
does not show the same growth. The installed DefaultInline.HardBreak scans the
remaining ASCII-space run, returns unhandled unless it forms a hard break, then
repeats at the next character. Source offsets and supported metadata must remain
intact; no dependency change, silent cap or dropped syntax.

## Decision

Configure a private metadata parser in src/wiki/markdown-references.ts replacing
only its named HardBreak inline parser via Lezer's existing configuration API.
Preserve stock behavior for a backslash followed by newline and two or more
ASCII spaces followed by newline, including exact HardBreak nodes and spans.
Other ASCII-space runs advance to their end without emitting a node; unrelated
characters remain unhandled. Use public InlineContext.char, elt and addElement.
Do not use private append, alter node_modules, normalize source, or modify the
renderer's global parser.

Skipping ordinary spaces is equivalent to the stock parser advancing over them
without nodes. Delimiter decisions and extraction continue reading the unchanged
original source. Preserve stock CRLF behavior as presented to InlineContext.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Private HardBreak override (selected) | Small fix of measured cause; original text/offsets | Equivalence must be maintained across Lezer updates |
| Compress spaces and map offsets | Can bound whitespace work | Complex node-boundary mapping; titles/labels/code/hard breaks can change |
| Bounded chunks/paragraphs | Bounds each parse | Cross-block reference definitions/fences/multiline syntax require extra context |

## Consequences

The measured whitespace family becomes linear without reducing metadata coverage.
Other documented grammar limits remain; this does not prove all upstream parser
paths linear. Review the workaround and equivalence tests when Lezer changes.

## Risks

The riskiest assumption is semantic equivalence when consuming an ordinary run
without a node. Compare complete stock/configured node names and source spans on
short cases: one/two/many spaces, tabs, LF/CRLF, escaped breaks, emphasis, code,
links/images/titles, full/collapsed/shortcut references and multiline labels.
Verify exact metadata destinations/offsets after large internal runs and reference
definitions after earlier uses. Reproduce RED first, then characterize10–80k runs
and normal prose. Revise if equivalence fails, another path dominates ordinary
inputs, or upstream fixes the issue; a parser replacement needs a separate ADR.

Evidence: architect read-only analysis of installed source and engineer benchmark
at metadata4ad171d. This is an accepted mitigation design, not completed evidence.

## Verification

The private parser's complete syntax-node names and offsets match the installed
stock parser on a short matrix covering LF/CRLF, spaces/tabs, escaped newlines,
emphasis, inline/fenced/indented code, links/images/titles, reference forms,
multiline labels, and footnotes. Metadata regressions preserve the original link
spans and decoded destinations across long internal/trailing space runs.

Local macOS characterization (milliseconds, one run per input; timing is evidence,
not a throughput guarantee):

| Characters | Stock whitespace | Metadata whitespace | Metadata prose |
| --- | ---: | ---: | ---: |
| 10,000 | 74.94 | 2.55 | 3.08 |
| 20,000 | 290.58 | 1.93 | 3.44 |
| 40,000 | 1466.08 | 2.10 | 7.24 |
| 80,000 | 6101.65 | 9.08 | 20.11 |

Before the override, the two 40,000-space metadata regression cases took 1764ms
and 1715ms, failing their 500ms regression budget. Afterward all four parser tests
completed in 13ms. The affected extraction/characterization/bootstrap/fixture/CLI
suites passed (43 tests, one existing expected failure). Typecheck, build, and the
headless, wiki SDK, and wiki CLI Node proofs passed locally. Full-suite and desktop
integration gates remain separate delivery checks.
