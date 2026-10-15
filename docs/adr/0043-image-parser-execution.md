# ADR-0043: Isolate complete Lightbox source parsing

**Date:** 2026-10-15  
**Status:** Accepted by coordinator under the reversible tested-PR authority. Runtime proof is required before implementation depends on this boundary. No Lightbox UI or production hook is authorized by this document alone.  
**Related:** ADR-0042 Lightbox private boundaries; ADR-0034 PDF isolation  
**Task:** `1e0e39a1-ac8d-48f6-8e41-0a7f3c98d73e`  
**Reviewed baseline:** `ef8a4891c955933e3d7e2f0ef87f56c9bb91fb16`

## Context

The private Lightbox projection currently parses the complete current LF snapshot
synchronously using the installed Markdown grammar. ADR-0042 accepts snapshots
through 300,000 UTF-16 code units and prohibits prefix galleries.

The valid 300,000-unit nested-bracket fixture takes 13,588ms and fails the existing
five-second characterization. Installed grammar evidence identifies repeated
backward scanning in `LinkEnd`; the existing ordinary-space correction addresses
a different path. Input length bounds do not provide an acceptable renderer
blocking bound.

Success means retaining complete-source grammar, reference precedence, exclusions
and exact image occurrence identity while keeping the interactive renderer
responsive and allowing obsolete parsing to stop independently of image reads.
It does not mean making the grammar faster.

ADR-0034 records that a direct custom-scheme worker from the file-origin renderer
failed before its handler received requests. Its subsequent fixed-document
approach has stronger local evidence: `docs/design/pdf-p1-implementation.md`
records hardened `bb1a25b` proof, and protocol, handshake and proof sources
implement a fixed cross-origin document with a same-origin worker. The proof
observes the file parent's message origin as `null`, requires its actual
WindowProxy identity and exercises production preload/preferences.

That supports evaluating the structural pattern. It does not prove a new
Lightbox broker, parser bundle, response policy or lifecycle. Constraints are no
new dependencies, public interfaces, network capabilities, metadata behavior
changes or production Lightbox hooks in this package. Image authorization,
decoder lifecycle, focus and native-draft protections remain separate ADR-0042
responsibilities.

## Decision

Use a private fixed-resource broker iframe that creates one same-origin dedicated
parser worker, conditional on the locked Electron proof below. Keep grammar and
potentially expensive source analysis in the worker. Resolve indexed files and
grant occurrence authority only in the trusted host after a current validated
result.

### Fixed runtime boundary

Use a separate application-resource origin, provisionally:

- `geode-image-parser://broker/index.html`
- `geode-image-parser://broker/broker.mjs`
- `geode-image-parser://broker/worker.mjs`

Serve only those exact GET URLs from fixed packaged bytes. Reject other received
URLs and methods. Do not derive filesystem paths from requests, redirect, proxy
or serve vault content. Chromium URL normalization limits claims about authored
spellings; test the handler's actual received URL boundary.

The broker has no product UI or source-derived HTML. It is nonfocusable and
outside keyboard navigation. Its iframe sandbox permits scripts and its own
origin only. This does not grant equality with the file parent or establish an
Electron process sandbox.

Keep Node integration in subframes/workers disabled, web security enabled and
the broker free of preload/IPC/plugin capabilities. Verify actual globals rather
than replacing them through build defines.

Broker response policy starts with:

```text
default-src 'none'; script-src 'self'; worker-src geode-image-parser://broker/worker.mjs; connect-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

Worker response policy starts with:

```text
default-src 'none'; script-src 'self'; worker-src 'none'; connect-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'
```

No parser WASM, string evaluation, inline script, blob worker or remote permission
is required. Bundle static dependencies into fixed entries without lazy chunks.
Admit only the fixed broker document in the parent's frame policy while
preserving existing application requirements.

### Initialization and authority

Use host-initiated initialization analogous to the accepted PDF clarification:

1. Capture iframe WindowProxy, current coordinator epoch and a fresh unpredictable nonce.
2. Transfer one private MessagePort to the exact broker origin.
3. Broker accepts initialization once, only from its actual parent and the parent origin demonstrated by browser proof.
4. Readiness matches protocol version, build identity, nonce and captured epoch.
5. Reload, replacement or disposal invalidates the port and every outstanding generation.

The observed PDF parent origin is `null`; origin alone cannot identify a file
parent. Do not generalize to other hosts without proof. No wildcard target-origin
fallback is allowed.

Messages use exact private schemas. They contain no executable instructions,
filesystem capabilities, resource URLs, owner objects, callbacks or host-I/O
requests. Unknown kinds/fields, invalid counts and mismatched generations cannot
acquire work or authority.

### Complete source and grammar

Before submission, host checks the complete source is LF-only and at most
300,000 UTF-16 units, capturing owner/file, Vault/root and snapshot identities.
Authority objects stay host-side. Worker input contains only protocol/build/
session/request identifiers and the complete source. Worker independently
validates length and LF requirements.

Extract pure analysis from the current helper without changing semantics:

- Installed configured grammar and shared reference normalization.
- Same-length code, comment and frontmatter exclusions.
- Existing conservative raw-HTML exclusion.
- Wiki and direct/reference Markdown images, including linked images.
- First-definition reference precedence.
- Exact original UTF-16 positions, authored destinations, labels, titles and linked context.
- Existing omission of nested images and unsupported correspondence.

Do not replace this with a permissive regex, private grammar patch or shortened
snapshot. No synchronous parsing fallback runs in the host.

### Serializable packed results

Return source descriptors, not syntax trees, DOM nodes, resolved files,
occurrence keys or repeated expanded destination strings. Use versioned
transferable `Uint32Array` tables:

- Candidate rows, twelve words: occurrence `from/to`, label `from/to`, authored destination `from/to`, title `from/to`, selected definition index or sentinel, syntax/link flags, two reserved zero words.
- Definition rows, six words: original label, destination and title `from/to` spans. Include only definitions selected by a returned candidate; share one row across repeated uses.
- Issue rows, three words: source `from/to` and an allowlisted numeric reason.
- An absent optional span uses a documented paired sentinel, not ambiguous empty coordinates.

Worker performs normalized-reference selection. Direct candidates point to their
own destination span; reference candidates point to the selected original
definition. Flags specify existing wiki trimming and Markdown destination
decoding rules.

Each table has at most `source.length` rows. At the ceiling these conservative
bounds total 25.2MB of payload; impose a 32MiB aggregate transferable-buffer
ceiling, excluding the bounded input snapshot. Validate actual byte lengths and
row widths, not claimed counts. Empty input produces empty tables.

Host validates buffer types, sizes, widths, integer flags, sentinels, definition
references and in-source ranges. Candidate order is source order with nonempty,
nonoverlapping image spans. Reject an entire malformed result; never publish a
prefix.

Decode each distinct destination/title span once, sharing values across reference
uses. A long reference destination used by many images must not be copied into
every row or repeatedly decoded. Worker parse allocations remain browser-managed;
the transport budget is not a total heap bound. Tests must show this representation
preserves all supported accepted-ceiling fixtures. Revise representation rather
than silently reducing coverage if a bound rejects one.

### Host-side ownership and resolution

After receipt recheck captured owner path/object, indexed owner identity, current
snapshot, Vault/root and coordinator epoch before any resolution. Only trusted
host applies existing local-path/raster checks and same-vault indexed resolution.
Preserve missing-image positions and resolver-error behavior, including indexed
extensionless aliases. Resolve distinct targets once per context only where
equivalent to existing semantics. Assemble bounded batches so dense galleries do
not become another long renderer task.

Recheck ownership between batches and before publication. Verify resolved target
paths/indexed identities; mint fresh private occurrence keys and retain context
only after validation. A matching request number alone does not prove authority.
Reading markers and node authority stay host-side. Worker output cannot authorize
image reads, bind arbitrary DOM or inherit plugin/transclusion authority.

### Scheduling and lifecycle

One private parser coordinator per App owns one active request and one latest
pending intent. Replace obsolete pending intent; no unbounded queue, source cache
or completed-request history.

A newer intent immediately invalidates the active generation and requests worker
termination through the responsive broker. Broker retains its worker handle until
calling `terminate()`, removing listeners and acknowledging local disposal over
the owned port. Create a replacement only after this cleanup boundary.

An abort message cannot interrupt synchronous worker parsing; broker must
terminate it. Distinguish host invalidation, broker termination request plus local
listener/handle release, absence of obsolete publication, and complete browser/OS
resource settlement. Only the first three are application contracts here.
`Worker.terminate()` has no OS-settlement promise; its return or frame removal
does not prove process exit or memory reclamation.

Initial private budgets are eight seconds for broker readiness and thirty seconds
for active parse after worker readiness. These are reversible product error
deadlines, not execution guarantees. Timeout invalidates, requests termination
and reports explicit failure. It does not lower the source ceiling or return an
empty gallery as success.

Cancellation is independent of parse completion. Exact-owner close, source/session
invalidation and App cleanup synchronously stop admission and invalidate pending
intents before cleanup. Cleanup cannot wait for synchronous parsing to return
before sending termination.

If broker communication fails, close ports/remove frame, reject active/pending
requests and disable that coordinator epoch. Do not automatically replace workers
while cleanup is uncertain. Runtime proof must establish the lifecycle behavior
used by recovery; otherwise return for an isolation decision. No hidden retry,
fake worker, host parse fallback or suppressed cleanup failure. Diagnostics are
bounded codes/text without source snippets or private paths.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Fixed Node-free broker and same-origin dedicated worker — chosen | Preserves complete-source grammar, independent cancellation; adapts evidenced pattern without dependencies | Additional assets, protocol, lifecycle and an Electron proof gate |
| Lower complete-source ceiling | Smallest code change | Gives up accepted 300k coverage; no general execution bound |
| Replace or privately correct grammar analysis | Could reduce CPU while retaining ceiling | Largest semantic/maintenance risk; needs separate audited equivalence algorithm |

A dedicated sandboxed guest is a fallback only after a new decision if fixed-
document proof fails. It expands lifecycle/messaging complexity. Disabling web
security is rejected.

## Verification Required

1. Semantic equivalence: packed-worker output vs existing wiki/direct/reference/linked/duplicate cases, exclusions, Unicode offsets, missing targets, extensionless aliases, first-definition precedence and authored labels/titles. Metadata and note/image bytes unchanged.
2. Preserve demonstrated RED: retain nested 300k fixture and recorded synchronous failure as causal baseline. Prove the same complete fixture through the asynchronous path with actual renderer heartbeat/input responsiveness and no truncation. No skip, smaller input or raised old synchronous timeout produces GREEN.
3. Bounds: ceiling/over-ceiling, dense gallery, long shared reference definitions, malformed tables, excessive counts, detached buffers, invalid ranges/flags, bounded errors. Repeated definitions cannot multiply payload size.
4. Actual isolation: packaged file parent with real preferences/preload; actual broker/worker globals lack Node/bridge APIs; broker cannot access parent DOM. Native fetch/XHR/WebSocket/import/eval/descendant-worker probes show policy denial and zero synthetic server side effects. Mock rejection or timeout alone is insufficient.
5. Startup/integrity: fixed-resource inventory, response CSP/MIME/nosniff, build hashes, real startup/version handshake. Wrong source/origin/nonce/port/build/epoch, duplicate initialization and reload cannot obtain authority.
6. Lifecycle: cancellation during actual slow parse, deadline, latest-intent replacement, owner/source/Vault change, worker error, malformed result, broker failure and repeated close. Assert controls remain reachable, pending intents invalidated, listener/timer/port cleanup and late-result rejection; no inferred OS settlement.
7. Independent review and fresh required gates on a frozen implementation. Private runtime proof does not establish UI interactions, exact table mapping, decoder cleanup, focus safety or Obsidian parity.

### Execution sequence and characterization provenance

First implement and verify an isolated actual-runtime proof against frozen assets,
without production hooks. Only after that proof is reviewed may engineering move
source analysis behind the worker boundary and add host validation/resolution.
Keep the original synchronous timing result and fixture immutable in evidence.
New asynchronous acceptance must exercise the identical complete fixture and
oracles, actual responsive host interaction and cancellation. Its explicit test
budget measures the newly accepted asynchronous contract; it cannot be described
as repairing or accelerating the old synchronous parser. Any relocation of the
old characterization to this actual asynchronous harness must be reviewed with
full before/after scope and preserved baseline evidence, not skipped or silently
quarantined to force a full gate. A synchronous renderer entry is never a fallback.

## Consequences

Renderer avoids synchronous grammar blocking while retaining accepted semantics.
Parsing can remain slow and consumes bounded-admission browser work. Cost is a
private resource origin, serialized protocol and explicit unavailable/recovery
states. Packed spans avoid syntax-tree transfer/reference expansion; host
resolution separates parsing from filesystem authority but needs bounded scheduling.

## Risks

Riskiest assumption: locked Electron enforces this new boundary and permits timely
broker termination while parsing is busy. PDF evidence supports the approach but
cannot substitute for parser-specific proof. Thirty seconds may be insufficient
on slower supported hardware; budget changes require measured evidence and an
honest interaction decision, not a speedup claim. If the complete ceiling remains
impractical, revisit execution or explicit product limits.

A failed broker cannot provide trustworthy termination acknowledgement. Recovery
remains unavailable until its lifecycle boundary is proved or replaced. This does
not promise universal process cleanup, decoded-image reclamation or complete parity.
