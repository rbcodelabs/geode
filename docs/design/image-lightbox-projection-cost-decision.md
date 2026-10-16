# Image occurrence projection: synchronous grammar cost decision

Task: 50f8c2c5-4ab1-4221-8082-64a98fc8172e; Solution: a305ef82-0d46-473a-a18f-057ba6a67cb7.
Status: proposal only; no alternate architecture implemented. The phase 1A helpers
remain private and unwired on the exact 707699d parent. Accepted ADR0042 defines a
300,000 UTF-16 complete LF source ceiling and explicitly requires a new execution
or limit decision when the installed synchronous grammar still blocks too long.

## Evidence

The first 13 behavior regressions pass for owned wiki/direct/reference/linked
images, exact UTF-16 spans, duplicates, exclusions, missing/error positions,
current snapshot/vault/root/index identity, unchanged metadata semantics, and
opaque Reading marker escaping/forgery/duplicate/replay/staleness rejection.
No production rendering, editor, App, host, IPC or public API is wired.

A valid ceiling fixture of 150,000 `[` characters followed by 150,000 `]` characters
returns an empty complete projection but takes 13,588ms locally. It fails Vitest's
existing 5-second timeout; the failure is preserved. Five other 300k characterization
cases pass, including ordinary whitespace/prose, unmatched openers/images and a
dense 20,000-image gallery. These results do not establish a general execution
bound. No synchronous mid-parse cancellation is claimed.

An independent installed stock parser check on the same nested shape measured
10k: 20.25ms, 20k: 53.20ms, 40k: 200.78ms, 80k: 815.07ms. The shared metadata parser already has
ADR0033's ordinary-space HardBreak correction; this is a different rule/path.
Installed `@lezer/markdown/dist/index.js`, DefaultInline.LinkEnd (around 1485), scans
backward across the parts array for each closing bracket. After invalidating an
opener it leaves a null part; subsequent closes repeatedly scan that suffix.
This is consistent with the measured quadratic growth. The private projection
uses that installed grammar and does not alter this rule or global rendering.

The complete characterization outputs are preserved in local logs:
`/private/tmp/geode-lightbox-projection-characterization.log`,
`/private/tmp/geode-lightbox-stock-nested-characterization.log`, and
`/private/tmp/geode-lightbox-nested-comparison.log`. The matched nested fixture,
not unmatched openers, is the demonstrated slow case. The first no-output
observation was explicitly corrected after the complete log was available.

## Options

| Approach | Benefit | Cost and unresolved proof |
|---|---|---|
| Explicit lower complete-source ceiling before parsing | Smallest implementation; preserves exact installed grammar/reference/exclusion semantics for supported notes | Around 10k/20k already costs 20/53ms for this shape before other work; any chosen threshold needs a real budget and broader adversarial matrix. Larger notes become explicitly unsupported, with no prefix gallery. It gives up the accepted 300k coverage and does not prove all grammar cases bounded. |
| Image-only scanner or a private corrected grammar profile | May keep 300k normal-note coverage and avoid link-only quadratic work | A second permissive image regex is rejected. A replacement must prove CommonMark reference normalization/first-definition rules, nested linked images, escapes, code/comments/frontmatter/raw-HTML exclusions and exact source spans. A private LinkEnd override would need unsupported internal parser details or a new audited algorithm; it cannot be assumed as small as the public HardBreak fix. |
| Bounded isolated parser worker; validate ownership/resolution on main thread | Retains complete 300k grammar semantics without blocking the interactive renderer; queued obsolete parse work can be terminated separately from image I/O | New private worker boundary/build/lifecycle and real Node/CSP/termination proof required; source spans/results must be serializable, with current snapshot/vault/index checks repeated before publication. One active task/latest intent, bounded inputs/results and no host I/O. A 13s parse can remain slow but cancelable; timeout cannot be described as synchronous parser cancellation. |

Recommend the isolated execution option if retaining the accepted 300k complete
coverage is required. Keep grammar span extraction serializable and perform
same-vault indexed target resolution/current owner checks on the main thread
only after a current result. If added worker complexity is out of scope, explicitly
choose a lower complete-source ceiling and document its coverage loss instead.
The image-only algorithm has the largest semantic regression risk and should not
be introduced merely to hide this fixture.

Root/architect decision is required before implementation or UI wiring. Current
code remains unwired; the known timing failure blocks a completion or parity claim.

The bounded paired stock/projection test passed for 10k/20k/40k/80k in 2.45 seconds
aggregate. The current Vitest reporter suppressed console output for successful
cases, so individual paired timings were not retained; the independently printed
stock values above are the actual retained per-size measurements. No second
benchmark was run merely to recover missing console output. The 13 original
behavior cases plus an indexed extensionless-alias regression are green. A
regression for mutable indexed target rename initially failed and now passes by
capturing original owner/target paths, not reading their mutable path fields as
historical identity. Final focused metadata+foundation gate: 33 passed plus one
pre-existing expected failure across four files. The ceiling timeout remains an
unresolved red characterization and is not quarantined or relabeled as success.

Additional current limits: no exact TableWidget normalization correspondence is
implemented, no UI or context acquisition exists, raw HTML paragraph contexts are
conservatively omitted, and authored alt/title text remains literal and escaped.
Raw error details and disk/image reads are not introduced by these helpers. The
Reading materializer emits no source URL: only uniquely minted private marker
nodes can receive an occurrence, and token attributes are removed on valid and
rejected binding attempts. Actual browser transform fidelity remains a later
gate on a frozen shared integration base.
