# Network resilience

Motivation: on 2026-10-15/16 the renderer-hang watchdog (20 s heartbeat, `src/main/main.ts`) fired after the
network had been down for 30+ minutes. Retries were low-volume but unbounded, backoff was defeated by polling,
and a large plugin `data.json` was re-serialized on the renderer thread. This document is the policy now in code.

## Shared backoff (`src/shared/backoff.ts`)
`nextDelay(attempt, { baseMs, maxMs, jitter, random })` = `min(maxMs, baseMs * 2^attempt)` then jitter
(`none`, `equal` = [raw/2, raw], `full` = [0, raw]). `Backoff` counts consecutive failures; `reset()` on success.

## Sync service (`src/renderer/sync/sync-service.ts`)
- Failed runs retry at 2 s doubling to a 5 min cap, equal jitter. A completed run resets it.
- The 30 s poll and file-change events cannot run inside the backoff window: `schedule()` clamps non-retry
  requests to the window end, and leaves an already pending timer alone.
- `navigator.onLine === false`: no run, no ssh spawn. The `online` event resets backoff and runs after 0-1 s jitter.
  The listener is removed in `cancel()`.

## Plugin `saveData` (`src/renderer/plugin.ts`)
Per data file: latest value wins, one trailing debounce of 1 s, one write in flight, serialization at flush time
only (one stringify per flush), writes skipped when the text equals the last written text. Payloads over
256 KB are written compact; smaller ones keep 2-space indent. Flushed on `unloadAndWait()` and best effort on
`beforeunload`. The promise resolves when a snapshot at least as new is written and rejects if the write fails.

## Host HTTP (`src/main/network.ts`, `src/renderer/host/electron-host.ts`)
- Per sender: at most 6 concurrent fetches, FIFO queue of up to 256 more; beyond that the request is rejected
  ("Request queue is full"). Queued requests are cancellable and never fetch once aborted.
- Per origin circuit: after 3 consecutive transport failures ("Network request failed", not HTTP statuses) calls
  fail fast with the same message for an exponential window (1 s base, 30 s cap, equal jitter). After the window
  the next call is a probe; any HTTP response resets the circuit.
- The renderer rejects immediately with "Network request failed" when `navigator.onLine === false` (no IPC).

## Out of scope (external to this repo)
- `GDocsPoller` in the vault plugin `obsidian-gdocs-sync` (minified `main.js` under `.geode/plugins`).
- `RelayClient` in the `claude-threads` plugin (its WebSocket reconnect loop).
Their own retry/backoff must be fixed upstream; the host queue and circuit only bound the damage.
