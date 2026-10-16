# ADR-0044: Preserve SSH diagnostics after stdout EOF

**Date:** 2026-10-15
**Status:** Accepted by coordinator on 2026-10-15 under the authorized reversible bug-fix scope.
**Delivery:** Task `e68dca81-6b97-4d5d-802d-668d526080e4`; authorized overnight parity verification work. No parent SSH Solution established.

## Context

An SSH process can close stdout before writing its final stderr diagnostic. `Connection.readLoop()` currently marks the connection failed and immediately calls `transport.close()`, which destroys stdin and sends SIGTERM. That can stop the producer before it writes its diagnostic. Waiting afterward for `transport.drained` cannot recover unwritten bytes.

Three controlled regressions on unchanged `3bbf6c0` reproduce authentication, missing-binary and host-key failures becoming generic `unavailable`. They use the actual Hub manager, connection and transport code with controlled child scheduling and real PassThrough streams. Existing actual-child tests also cover newline-free diagnostics and a 400 ms connection deadline.

Constraints: preserve protocol/API compatibility, immediate RPC failure, explicit cancellation, existing deadlines and bounded cleanup. No dependency, automatic retry, general process supervisor or descendant-process guarantee.

Success means late diagnostics survive ordinary EOF, while cancellation and explicit close still reach the child after the RPC connection has already failed.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Immediate RPC failure with privately owned EOF cleanup grace | Preserves failure timing and permits final diagnostics; existing forceful close remains usable | Must retain retiring connection ownership and distinguish EOF from explicit shutdown |
| Wait for stderr drainage before failing RPC | Simple apparent ordering | Keeps handshake pending; current client close awaits that handshake and can become ineffective |
| Move all subprocess ownership into Hub manager | Central diagnostic and cancellation ownership | Broadens responsibility across CLI/RPC callers and duplicates transport lifecycle handling |

## Decision

Use the first option, accepted by the coordinator.

### Separate RPC failure from subprocess retirement

On normal stdout EOF, immediately mark the connection dead, reject pending RPC requests and prevent further requests on it.

For transports created by `spawnTransport`, disconnect stdin immediately, releasing blocked writes, but allow the producer to finish stderr and exit within the existing **1,500 ms diagnostic budget** before requesting forced shutdown.

Keep this association private to the module—for example, a WeakMap from spawned transport objects to EOF-cleanup functions. Do not change the public `StoreTransport` shape or infer subprocess behavior for arbitrary injected transports. Transports without this private capability retain immediate existing cleanup.

Protocol/parser errors, stream errors and explicit shutdown retain forceful cleanup. Grace must not introduce another RPC attempt.

### Preserve explicit shutdown ownership

RPC death does not mean subprocess cleanup completed.

`RpcClient` must retain handles for retiring connections until their bounded cleanup finishes. Explicit `close()` must close both live and retiring connections, including connections already marked dead, without first waiting for their failed handshake to settle.

Repeated failure may remain a no-op for request rejection, but must not prevent explicit forceful cleanup. Check client closure after asynchronous connection allocation so a late allocation cannot resurrect a closed client.

### Keep drainage truthful and bounded

`drained` continues to mean observed child close with all collected stderr delivered, including an unterminated final line. A successful `kill()` return is not drainage or proof of process exit.

Observe drainage rejection and dispose timers/listeners on every terminal path. If drainage never settles, request existing forceful close when the grace expires; never wait indefinitely for stderr.

Forceful close remains a termination request. This patch does not promise termination of signal-ignoring children or descendants. Existing actual-child tests must independently observe that their owned child disappears.

The EOF grace and Hub diagnostic collection wait run concurrently within the existing budget; do not add successive grace windows.

### Honor cancellation during classification

Hub failure classification must observe the live caller signal and connection deadline while waiting for stderr. An abort/deadline must initiate forceful provider closure promptly and interrupt diagnostic waiting.

Re-evaluate cancellation and timeout after the wait. The current captured `timedOut` boolean must not allow a timeout occurring during drainage to become `unavailable` or an SSH classification.

Explicit cancellation reports cancellation; deadline expiry reports timeout. Recognized stderr refines ordinary connection failures only. Preserve the existing classification rules otherwise.

## Consequences

SSH failures become more actionable without delaying RPC rejection or changing the wire protocol. Connection lifetime and subprocess retirement become explicitly distinct private responsibilities.

We give up immediate process termination after clean EOF for a bounded opportunity to receive final diagnostics. Generic transports receive no new lifecycle assumptions. Existing reconnect-on-a-later-call behavior remains unchanged.

## Risks

The riskiest assumption is that every allocated child remains reachable by explicit close after connection failure. Retiring-handle tests must prove this; a dead connection flag alone is insufficient.

Revise the recommendation if the private association becomes difficult to maintain, supported callers require stronger process termination guarantees, or stderr collection requires a broader transport contract.

## Required Verification

Before implementation, preserve the controlled RED results. Then verify:

- All three late-diagnostic cases pass, including newline and no-newline tails, with one spawn and no premature kill.
- Natural child close delivers the final tail once; repeated close is idempotent.
- Stdout EOF with stderr/exit withheld reaches bounded forceful cleanup.
- Explicit close after EOF reaches the already-dead retiring child.
- Explicit close during an incomplete handshake does not await the diagnostic grace first.
- Caller abort and deadline expiry during classification interrupt drainage and retain their correct error codes.
- The existing 400 ms actual-child timeout test retains its deadline and observes child disappearance.
- Stream/protocol errors retain immediate cleanup.
- Optional `drained`, rejected drainage and void/promise close implementations produce no unhandled rejection or retained cleanup timers.
- Existing real SSH stand-in, RPC and Hub tests pass without weaker assertions, retries or arbitrary sleeps.

This ADR records the accepted design, not successful implementation or verification. No merge, release, paid resources or external messaging is authorized.
