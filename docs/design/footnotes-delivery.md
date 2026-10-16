# Footnotes delivery provenance

Delivery Task `43bc4c29-0f3f-4de1-b279-90ac9c4d76ff`, Solution
`e0b922c6-e23d-49ae-9bfe-a53df1c76a96`, behavior KR
`c3b390f0-92a8-479c-b629-2b6745d577d5`.

This delivery replays only the four reviewed original Footnotes commits
`3b2e055`, `8edb1fa`, `fd91fa6`, and `7806735` onto tested Metadata delivery
`680f7e4528e1d7f7c5294601f3a476ce4174de75` (PR386). All four compare equal
in range-diff. The accepted [feature design](footnotes-pane.md) is retained;
[ADR0031](../adr/0031-sidebar-properties-parity.md) is copied unchanged from
accepted design commit `b0b44d2` so its referenced ownership decision is readable.

The only test follow-up replaces the restart fixture's fixed 600 ms delay with
actual persisted workspace checks, including saved Footnotes presence before
restart and absence after disabling. App configuration checks retain their
original false oracle. JSON polling tolerates only absent files or incomplete
JSON; unrelated filesystem errors propagate. Assertions and default timeouts
remain unchanged. No new production behavior accompanies this packaging.

The separate native asynchronous-navigation correction (`707699d`, Task
`d1a0384b-8282-4b1a-a352-862be5c2f0af`) belongs to the later native editing
integration. It is intentionally excluded: this prerequisite still has the
original synchronous MarkdownView navigation implementation.

Historical tests and screenshots remain historical. A fresh full worker gate
and fresh synthetic desktop/compact captures are required for this delivery.
Limits remain explicit: first 8,192 UTF-16 source units, at most 200 rows,
partial-definition editing refusal, and the shared scanner grammar. This is a
bounded feature package, not complete Footnotes or Obsidian parity.

## Final verification

The exact candidate `31e5deba84fcc0f92adfd6270d5fd1ad7b72f106` passed full
worker job `01M4ZZPJXYTSSYA61T51K1XSMJ`: install/types/build;324unit files,
4758 ordinary passes, one documented expected failure and three existing skips;
full394Electron accounted379ordinary passes and15existing conditional/fixture
skips, with no failed attempts/retries. Fresh synthetic desktop/compact captures
were inspected and delivered in the repository and authorized vault QA report.
Artifact manifest SHA256:
`e72588dad09f9cc91cc363bad3bdb27741f843327f03c4dee4ee75022cd76702`.

The prior exactcc1653 full run failed twice at NoteComposer's immediate rewritten
Linker.md assertion. Production merge awaits destination first, then referencer
writes; the destination alone was an insufficient test completion barrier on
Linux, where source-trash completion is unsupported. A controlled real
Vault.modify gate now proves that intermediate state, releases in finally, then
awaits the original exact rewritten-byte assertion. The analogous prepend
assertion also polls its original contains oracle. No production merge behavior,
assertion content, timeout, retry or skip changed. The failed full run remains
archived; the corrected full run passed without retries. These screenshot/docs
updates leave source and tests identical to that exact passing candidate.
