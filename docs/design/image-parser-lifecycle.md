# Private parser lifecycle checkpoint

This unwired ADR0043 foundation belongs to phase2 Task `c694e1fe-546a-4b45-b612-d6f8b9f8649f` and Lightbox Solution `a305ef82-0d46-473a-a18f-057ba6a67cb7`. It installs no App, Markdown, Live Preview, renderer, protocol-registration or image-read hook. Fixed broker/worker assets and native packed-runtime verification are still pending.

`ImageParserCoordinator.project(context, ownerToken)` requires a stable opaque object per view/render lifetime. This identity differs from `context.owner`, the indexed source file. Splits sharing a file require different view tokens. Future integration must supply real stable tokens and the resolver-affecting index epoch described in the packed contract; this checkpoint does not add those integration hooks.

One active intent and one latest pending intent are retained. Supersession aborts immediately but the replacement waits for actual transport settlement. Only an AbortError following the owned abort is normal cancellation. A fatal error arriving after cancellation still disables the coordinator epoch and rejects pending work. Allocation failure has the same policy; there is no automatic retry or host parser fallback.

Exact-owner close seals admission synchronously with weak ownership, including after close. A weak map records the close promise before invoking abort listeners, so reentrant/repeated closes share the retained cleanup outcome. Other views remain eligible. Global close starts transport cleanup before awaiting active work. Cleanup failure remains visible and prevents automatic per-App replacement. Only an explicit successful global close removes that App's coordinator mapping.

The browser transport owns its iframe and real MessagePorts synchronously before startup. It uses a fixed exact origin, a fresh 256-bit nonce, exact protocol/build/session/request schemas, and local per-session request IDs. Numeric epoch is currently fixed at one within each nonce-isolated transport instance; coordinator identity and nonce prevent cross-instance authority. The constructor does not register or serve resources. Startup/reload/error, source validation, response validation, cancellation and close are explicit. Initial readiness and local cleanup acknowledgements have eight-second deadlines; active parsing starts its thirty-second deadline after worker readiness. Cancellation settles only after the broker's matching local-release acknowledgement. That acknowledgement is not browser/OS process settlement.

Current tests use the actual transport with real MessagePorts and a synthetic document/broker adapter. They prove host lifecycle behavior, not Electron isolation, CSP enforcement, packaged-resource startup or actual worker termination. The existing Stage1 native proof is separate evidence; its Linux process sandbox was disabled. A new actual packed-runtime proof is required before depending on these new assets.

## Regression evidence

- Coordinator permissive scaffold: seven assertion failures and one positive case, then explicit view-token/fatal-after-abort, deferred/rejected retirement, closed-owner admission, repeated-close and reentrant-close assertion RED controls. Logs are preserved outside the repository in the phase2 QA archive.
- Protocol permissive scaffold: all three exact-schema adversarial tests failed assertions before implementation.
- Actual transport startup-close scaffold: frame-removal assertion failed while a real transferred MessagePort and incomplete handshake existed. The final unit retains the same shutdown assertion and observes pending parse rejection.
- Current focused checkpoint: 29 tests across coordinator (16), protocol (3), transport (4) and existing authority (6) pass. This is a focused unit result, not a full gate or completed PR.

The complete original synchronous 300k characterization and its recorded RED remain unchanged. No relocation, skip, reduced fixture or raised timeout is part of this checkpoint.
