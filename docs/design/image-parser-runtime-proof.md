# Isolated parser runtime proof

Task `cff5c914-9cba-487f-b1d4-a76f0fa22589`, Solution
`a305ef82-0d46-473a-a18f-057ba6a67cb7`. Accepted ADR0043 is the scope;
this package is test-only boundary proof, not production Lightbox integration.

Standalone `scripts/proof-image-parser-isolation.cjs` bundles three fixed broker
resources with the installed configured Markdown grammar. It runs the actual
built preload with production-equivalent Nodeful parent preferences, disabled
Node in subframes/workers and enabled web security. No globals are replaced by
build defines; only the synthetic probe port and generated sentinel URL are compiled into probes.
The separate custom origin accepts exactly three GET URLs and returns explicit
CSP/MIME/nosniff. Native probes test denied network/local-file requests, foreign
module import, evaluation, WebAssembly and descendant workers, with independent
synthetic-server connection/request counts. File denial uses an actual synthetic
sentinel, positively read by the privileged parent through fetch; the proof also
requires its actual CSP denial in browser console output. Parent DOM/Node escape
is tested. Served broker/worker bytes are archived with their hashes.

A private transferred port carries exact initialization and bounded LF source
requests. Duplicate initialization on a foreign port followed by forged parse/
cancel packets must receive no broker response; the owned port then performs
the positive parse/cancel control. Captured epochs propagate into worker replies.
The same complete 300,000-unit nested bracket fixture parses with the
existing configured grammar in a real worker. Host renderer heartbeat and actual
main-process input injection are counted only after the second worker reports
that grammar parsing has begun, excluding startup and native probe time. An initial busy parse is terminated
through the responsive broker; a fresh worker then completes the exact fixture,
with 300,000 tree units, zero images and no obsolete first-request publication.
The broker acknowledgement proves terminate was requested and its local handle
and listeners were released. It does not prove OS process exit or memory release.

Initial missing-export test failures were scaffolding checks only. A deliberately
permissive initial protocol scaffold then failed three meaningful assertions:
unknown URLs returned200 instead of404, invalid initialization was accepted, and
invalid/over-ceiling source was accepted. The narrow implementation passes those
checks. Logs preserve both runs. Actual Electron isolation remains unverified
until the frozen remote proof completes; unit fakes are not runtime evidence.

Original synchronous helper, parser grammar and known 13,588 ms nested fixture
RED remain unchanged. No production source, host API, build entry, main protocol
registration, extraction migration, packed descriptors, indexed-file resolution,
UI, native hooks, image reads or decoding are introduced. This proof is a staged
prerequisite; remaining ADR0043 semantic, packed-payload, lifecycle and integration
acceptance still require separate implementation and review.

## Verified Stage1 runtime evidence — 2026-10-15

The exact test-only candidate `345637b1c616a35bbc0c8585953b03dcce0bcad3`
passed worker job `01M4ZZ71432B208ASBZ4T3PN2D`: install, typecheck, four boundary
unit tests, build and actual Electron proof all exited zero. Linux test-worker-1
used Node24.21.0 and locked Electron42.10.0. Full fetched artifacts and served
resource bytes were independently checksum-verified; manifest SHA256:
`37a76e81acd8bbd946c637e014b42cc9573eeaf0c3486f0ee8bbc897971dbd50`.

**OS/Chromium process sandbox was disabled with `--no-sandbox` in this Linux
proof.** The initial canonical-CLI attempt aborted before JavaScript because the
checkout-local SUID helper lacked root ownership/mode4755. That failed attempt
is preserved as job `01M4ZZ0T51VD6TPF59TNAYK19G`, manifest SHA256
`1b2c50f2cc6a664b6993f912bb60d0403511ae56b1932a5752efc2eb00d36397`.
The coordinator approved only a launch-spec correction, matching the installed
Playwright Electron launch default. No system permissions or production settings
were changed. Observations below apply to this tested mode, not an OS sandbox.

The parent exposed real Node/preload APIs; broker/worker Node and bridge globals
were undefined. Parent DOM/Node escape failed. All native policy probes were
denied, with24 browser CSP diagnostics, zero synthetic-server connections or
requests, and a positive parent fetch of the actual sentinel file. Three unique
fixed resources were served across four requests; archived bytes match hashes.

The identical complete300,000-unit nested fixture produced a300,000-unit syntax
tree and zero images in19,934.6ms. During parsing,997 renderer heartbeats and199
actual injected input clicks were recorded. Cancel acknowledgement took0.30ms,
local worker handle/listeners were released, busy admission was rejected, no
obsolete first-request result published, and the fresh worker completed.
Termination acknowledgement is not OS-process exit or heap-reclamation evidence.

Original synchronous characterization source/fixture and its13,588ms RED remain
unchanged. Root accepted Stage1 only for the observed mode. Semantic packed-result
migration, strict host validation, batched indexed resolution and complete
coordinator lifecycle remain separate work. No full-suite pass, tested-PR handoff,
production hook, image decoding, focus safety or complete parity is established.
