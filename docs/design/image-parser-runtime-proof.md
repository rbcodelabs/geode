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
