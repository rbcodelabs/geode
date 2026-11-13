# QA final gate harness (Phase 2b-i): real Geode build + real Design plugin

Specs here launch THIS repo's Electron build with a built Design plugin (`threads-artifacts`) installed into a throwaway vault, next to a recording Agent Threads stand-in (`standin/`, exposes `api.v1`, records every call, can hold a thread busy, hang a send after delivery, emit run events).

They are skipped unless `QF_PLUGIN` points at a directory holding the plugin's `manifest.json` and `main.js`. They are not part of the normal e2e run.

    QF_PLUGIN=/path/to/built/plugin QF_VARIANT=new-new xvfb-run -a npx playwright test --workers=1 tests/e2e/qf/flow.spec.ts

`QF_VARIANT` is `new-new` (this Geode + new plugin), `new-old` (this Geode + plugin v0.8.2, v1 only) or `old-new` (Geode v0.30.18 + new plugin; only `matrix.spec.ts` applies, copy the `qf/` folder over an old checkout).

- `lib.ts` launch, artifact fixtures (a valid Design manifest around the repo's own fixtures), pick/pin helpers, comments.json readers.
- `matrix.spec.ts` negotiation matrix (Pin hidden or shown, Send now, nothing v2 written by a v1 path, 404, global command).
- `flow.spec.ts` pins, reload, agent edits (selector, text, landmark, detached, other page), rail, batch send, busy, unqueue, resend, foreign, reload mid-queue, corruption, vault-read.
- `hostile.spec.ts`, `keyboard.spec.ts`, `overlay.spec.ts` (DPR 1 placement error and a pixel sample of the badges).
- `tools/` how the heavy runs were driven through `tq` when only step names and exit codes are readable: results are re-encoded as per-step peak memory (`decode.mjs`, `getres.mjs`).

Tests named `BUG:` use `test.fail()`: they assert the correct behavior, currently fail, and turn red when the source is fixed.
