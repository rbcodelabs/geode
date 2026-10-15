# Private packed-parser runtime proof

Phase2 Task `c694e1fe-546a-4b45-b612-d6f8b9f8649f`, Lightbox Solution `a305ef82-0d46-473a-a18f-057ba6a67cb7`, accepted ADR0043. This is an unwired proof package, not a product hook or completed parity claim. No actual run is recorded by this design document.

The private fixed broker/worker installers and three-resource response handler are browser code. They are not registered by the app or added to its production build. Grammar remains worker-only. The host's async projection/coordinator/transport graph excludes Lezer and the parser entry. Exact GET URLs, response CSP/MIME/nosniff, resource inventory and whole packed-result validation remain mandatory.

Worker boot readiness stays broker-internal. After accepting the complete request, the worker posts the full session/request acknowledgement immediately before entering extraction. Broker forwards that acknowledgement once; only then does the host start the thirty-second active budget. Eight-second worker startup remains separate. This establishes source admission and an interval that excludes worker startup/probes; it does not prove OS scheduling or execution settlement. Controlled tests preserve boot privacy, pre-extraction ordering, duplicate/wrong-session/wrong-request rejection and result-before-start failure.

`scripts/proof-image-parser-packed.cjs` creates four fresh Electron windows with the actual built preload and production-equivalent preferences. Linux execution uses the previously accepted explicit `--no-sandbox` mode. The report must state that process sandbox limitation and must not infer browser/OS process termination or heap reclamation from local worker termination requests and handle/listener/frame/port release.

## Canonical mode

Serve the exact unmodified broker document and bundled real broker/worker entries. Archive all three bytes and hashes. The actual private coordinator/transport exercises:

- A native sibling frame sends initialization from the wrong actual WindowProxy/origin. A passive test-only observer in the target frame confirms that native event was processed before the legitimate parent initializes, avoiding a cross-sender ordering assumption. The legitimate file parent then completes a packed parse as a positive control. Unit tests additionally isolate wrong-source and wrong-origin conditions separately.
- Malformed build/epoch/nonce/extra-field initialization, duplicate port initialization and wrong nonce/epoch/extra-field/over-limit source requests cannot displace the owned positive parse.
- A real transferred endpoint returns owned readiness; parent-only synthetic observation withholds delivery to the host callback to make incomplete-handshake close deterministic. Pending parse rejects and the actual frame is removed. This is a controlled startup observation, not a production probe hook.
- The unchanged complete 300k nested-bracket source is admitted to the actual worker. Supersession cancels that request, replaces obsolete pending work and starts the latest complete request only after local release acknowledgement. No sleep substitutes for request-source acknowledgement.
- Actual main-process input injection and renderer heartbeats are measured after the latest source-admission event. Full output retains all 300k units with zero image occurrences/issues; obsolete generation output cannot publish.
- A reference image retains its authored span, label/title, decoded destination, indexed file resolution and host-minted opaque key. Exact-owner sealing and full close remain usable.

The original synchronous performance test, fixture and recorded failure remain unchanged. This harness is not its approved relocation and does not make the old parser faster.

## Instrumented native-probe mode

A separate fresh window serves explicitly different synthetic wrappers importing the same real installers. Both canonical and actually served instrumented bytes/hashes are archived, so the report cannot imply byte equality. The wrappers reuse the existing Stage1 native realm/CSP probes against a generated real sentinel file and synthetic local server. The trusted parent must read the sentinel as a positive control; broker/worker native access must be denied with CSP evidence and zero server connections/requests.

The worker's actual native `postMessage` call returns after transferring its actual three parser buffers; synthetic observation checks each original ArrayBuffer is detached. A test-only BroadcastChannel relays diagnostic facts within the broker origin. The instrumented broker holds the small result until that diagnostic arrives, preventing its normal immediate worker termination from racing the observation. This diagnostic delay is absent in canonical mode. No fake worker or replacement network/eval API supplies a denial result. The trusted parent waits for all diagnostic observations before closing this window.

## Verification status

Regression-first host/broker/worker/resource cases are local focused unit evidence. They include real MessagePorts under a synthetic document/worker adapter, which proves neither native frame transfer nor Electron isolation. Startup attachment failure cleanup, request admission, malformed result/error epoch disabling, no automatic retry, busy preservation and packed port transfer are covered there. Actual native modes, fresh independent full review, frozen remote types/build/focused tests and runtime artifacts are still required. A full gate and reviewed characterization/authority migration remain required before any completed PR claim.

## Separately labelled synthetic fatal fixtures

Two further fresh windows retain the canonical broker/document and serve distinctly archived fault-injection worker bytes. One worker throws at native startup; the other announces the actual request and returns a malformed packed result. These are synthetic producer faults, not canonical parser semantics. The actual broker/transport/coordinator must report the bounded error, refuse another request without reallocation, remove the frame, and retain the identical cleanup error. Each mode must fetch only one worker. Their bytes and hashes remain separate from canonical and native-probe assets.

The native sibling-frame test remains a smoke check of the combined source/origin rejection, even with passive receipt ordering; unit cases isolate the individual guards. Request admission is acknowledged immediately before extraction, which excludes startup/probe time from the measured interval without claiming OS execution scheduling.


## Host-origin API correction after the first frozen run

Exact `4b270608ce098a6df65efc2f797e03320b699906` passed remote types/build and 66 focused tests, then failed before serving any assets: Electron's `WebFrameMain.origin` reported `file://`, whereas the harness incorrectly expected the native message-event serialization `null`. The complete failed artifacts and manifest remain preserved. Installed Electron declarations describe the frame-origin API generically; the actual run is authoritative for that API value. The previously fetched successful Stage1 report directly records broker initialization `parentOrigin: "null", actualParent: true`.

The corrected harness records frame API, DOM location/global origin and URL origin separately, asserts the trusted parent uses the file protocol, and passively observes the actual valid owned initialization MessageEvent in the canonical target frame. That native event must still have origin `null` and the actual parent WindowProxy. Broker validation remains unchanged; no origin allowlist or wildcard fallback is added. This correction changes the diagnostic API assertion, not the isolation contract.
