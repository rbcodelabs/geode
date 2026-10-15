# Private packed image-parser contract

Task `c694e1fe-546a-4b45-b612-d6f8b9f8649f`, Solution
`a305ef82-0d46-473a-a18f-057ba6a67cb7`. This implements accepted ADR0043's
private phase2 foundations after the scoped Stage1 runtime proof. No production
App, main-window, Markdown, Live Preview, UI or image-reader hook is included.

## Transport and ownership

The worker receives only the complete LF source and private protocol identifiers.
It returns versioned Uint32Array candidate/definition/issue tables of widths
12/6/3, with paired `0xffffffff` absent spans. Syntax flags are Wiki1, Direct2,
Reference4 and Linked8; one base syntax flag is required. Reserved words remain
zero. Only selected definitions cross the boundary, shared across repeated uses.
Actual arrays must occupy their full, transferable ArrayBuffers; claimed counts
or subarray views do not hide extra payload. The aggregate ceiling is32MiB and
each table has at most source.length rows. Whole-result validation rejects bad
shape, buffers, widths, flags, references, sentinels, ranges or ordering.

The host's async projection receives a private parse transport. It never imports
a synchronous parser fallback. Host callbacks, indexed files, opaque occurrence
keys and owner objects do not cross the worker boundary. Validation precedes
resolution; distinct spans/targets may be cached only while ownership remains
current. Resolution and occurrence assembly run in bounded batches with yields.

## Required resolution epoch

The private source context requires `resolutionEpoch: object` and
`currentResolutionEpoch(): object`. Capture a valid non-null object token before
transport work; missing, null or primitive tokens cannot pass through
`undefined === undefined`. Recheck it after parsing, between batches and before
publication, together with owner path/object, indexed owner, Vault/root, snapshot
and captured target paths/index identities. The published projection's current
predicate retains that captured token too.

Every resolver-affecting index, name or alias mutation must replace the token.
An old target remaining indexed is insufficient: introducing a closer alias can
change resolution without removing it. A changed token rejects the entire stale
result rather than retrying or returning an empty gallery. Distinct target and
decoding caches cannot outlive that token.

This is a required future integration precondition, not an existing App or index
hook. Tests provide real mutable fixture epochs. Production integration must
supply actual invalidation; a constant/default epoch would violate the contract.

## Verification sequence

First preserve assertion-based RED for malformed packed buffers and ownership
races, then implement the pure worker extraction and host validator/projection.
Compare original grammar/reference/exclusion/source-span semantics, including
extensionless indexed aliases and shared long definitions. Exercise alias/index
mutation between batches while the old target remains indexed, target rename,
owner/root/snapshot changes, invalid initial epochs, and published invalidation.

Private transport/coordinator tests then cover one active/latest pending request,
real broker cancellation and local cleanup acknowledgement, deadlines, failure,
malformed results and no stale publication. The existing complete300k fixture
and original synchronous RED remain causal evidence. Relocating characterization
into the actual asynchronous Electron harness requires explicit full before/after
review with the same complete fixture/oracles and an accepted async budget.
No skip, quarantine, old timeout increase or mock-only full-gate claim substitutes
for that review. Actual UI, decoder, native ownership and complete parity remain
outside this foundation package.

## First implementation checkpoint

Pure extraction, strict table validation and asynchronous host projection have
18 focused passing regressions after assertion-based RED. Differential cases use
the original helper as a positive control for existing supported syntax and error
positions/order. The reference/title fixture includes the required blank line
before its definition; a single newline remains part of the preceding paragraph
under the installed grammar. No syntax was reinterpreted to satisfy the test.

A transient resolver exception is retained per occurrence and never cached as
stable authority; subsequent authored occurrences may resolve normally. Repeated
successful destinations share resolution only inside the captured unchanged
epoch. A thousand uses of one10k-character definition produce48,024 packed bytes
and one host resolution; strings are decoded by shared source span.

This checkpoint does not yet provide the actual packed-worker transport or full
one-active/latest-intent coordinator, and does not alter existing source/Reading
bindings or the known synchronous300k characterization. Those remain explicit
subsequent stages with independent review and actual Electron verification.

## Parser-free host dependency correction

Independent review found the host destination decoder import also configured the
Lezer grammar. The decoder now lives in a parser-free utility and its old export
is preserved by re-exporting the same function. A dependency-guard test denies
Lezer module loading while importing the host projection. Shared punctuation
unescaping remains explicit for both destinations and existing display labels.
An intermediate uncommitted extraction accidentally resolved the remaining label
call to global unescape; a parseMetadata regression for escaped punctuation and
literal percent sequences reproduced that error before correction. This state
was never a delivered candidate. The final affected-caller gate covers the shared
metadata callers in addition to packed foundation and import-boundary tests.
