# Preserve diagnostics after child stdout EOF

Status: historical proposal, superseded by accepted [ADR0044](../adr/0044-ssh-eof-diagnostics.md).

Task e68dca81-6b97-4d5d-802d-668d526080e4. The existing Metadata delivery gate failed the existing actual-child SSH classification regression on worker1. Base worker2 passed the same unchanged source. Latest upstream does not change this code. A deterministic three-case test using actual PassThrough streams plus a controlled child now reproduces incorrect unavailable errors for authentication, missing remote binary and host-key diagnostics. No arbitrary sleeps or rewritten classification expectations.

## Confirmed sequence

The child closes stdout, which is legal before its final stderr write. Connection.readLoop calls fail; fail rejects requests and immediately calls transport.close. spawnTransport closes stdin and SIGTERMs the still-live child. The producer can therefore be killed before writing its diagnostic. HubStoreManager already awaits transport.drained, but that cannot recover bytes the killed producer never wrote.

The regression waits for actual stdin-close cleanup and then allows a still-live child to write its final diagnostic and close. The unchanged code kills it first, so all three public HubStoreManager classifications fail. It exercises the existing connection, transport and classification implementation; the mock controls only child scheduling and signal effects.

## Options

1. Keep fail/rejection immediate, but defer forced transport cleanup after clean stdout EOF until the existing drained promise settles, bounded by the existing1500ms diagnostic drain budget. Abort, malformed input, transport error and explicit connection.close paths retain immediate cleanup. This avoids introducing delayed RPC error reporting, but a connection already retired by EOF must still own a bounded cleanup task; explicit close after that retirement must not lose ownership or leak a timer/process.
2. Wait for drained before publishing the EOF failure, with the same bounded budget. This keeps the child alive for its natural stderr/exit and preserves immediate fail paths for explicit close/abort/protocol errors. Pending requests remain cancellable through their current AbortSignal. The risk is that explicit RpcClient.close during a pending handshake currently awaits connecting, so deferring EOF failure can delay that close by the grace budget; avoid silently changing that behavior.

Recommendation for root review: option1 if immediate explicit shutdown can be preserved through the existing private Connection/RpcClient lifetime without adding a new public interface. Otherwise review option2 against a deterministic pending-handshake close test before choosing. Do not change StoreTransport public shape, add hidden retries, weaken deadlines or add an arbitrary sleep. Preserve original classification rules and the actual400ms hung-child test.

## Verification before delivery

- Three existing-classification controlled REDs become GREEN without changing their expectations.
- Explicit abort, explicit close and400ms hung-child cleanup remain prompt; closed-stdout producers that never exit are forcibly bounded, with no retained timer or process.
- Unterminated stderr tails and natural exits retain diagnostics; callbacks and close remain idempotent.
- Run the original real stand-in SSH child suite as well as the controlled stream cases, then independent review and complete required worker gate.

No parent SSH transport Solution was found in the live workspace lookup; this Task is a verification blocker linked to the authorized parity plan, rather than an invented product Solution. No merge, release, paid resources or external messages are authorized.

## Implementation verification checkpoint

The accepted option1 is implemented privately in rpc-store/app-hub. Spawned EOF cleanup releases stdin, preserves the existing1500ms concurrent diagnostic budget, and owns a retiring connection until bounded cleanup. Explicit close still force-closes already-dead connections; late asynchronous allocation checks client closure. Optional drainage rejection is observed without redefining drained as exit success. Hub classification interrupts waiting for caller cancellation/deadline and rechecks the live state. No StoreTransport shape, protocol, dependency or retry change.

Regression-first evidence: original three public classifications RED374ms; expanded initial matrix7RED/1existing protocolPASS356ms, before production changes. Extended generic-transport cases initially reproduced three unhandled drained rejections; a single observation handler fixes those without replacing the RPC failure.

Final focused local command includes the15controlled cases and original real SSH, Hub and RPC latency suites: four files109PASS+3existingSKIP,66.93sec, `/private/tmp/geode-ssh-eof-final-focused.log`. The controlled matrix covers late classification, already-dead explicit close, caller cancellation, existing400ms deadline,1500ms fallback, malformed/stream immediate failure, incomplete handshake close, late allocation, generic void/resolved/rejected cleanup, and natural final-tail idempotency. Actual original SSH tests retain the400ms owned-process disappearance assertion. These focused checks are not a complete gate; independent review and fresh full worker verification remain required.

Execution: authorized small local diagnostic/regression runs used Node26.8.2 and locked Vitest4.1.11. Subsequent full gate uses the verified worker pool, as required by the shared compute policy. No parent SSH-specific Solution was found; Task e68 explicitly records this verification dependency instead of inventing one.

Explicit original actual-child followup: fiveSSHcasesPASS3.97sec; forcedstdout-before-stderr casePASS556ms, unchanged400msdeadline/ownedPIDdisappearance casePASS459ms, `/private/tmp/geode-ssh-eof-actual-child.log`. This observes the owned test child, not arbitrary descendants or signal-ignoring processes.
