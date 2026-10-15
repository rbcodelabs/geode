# ADR-0038: Durable native presentations in Markdown

**Date:** 2026-10-15
**Status:** Accepted by coordinator, 2026-10-15. Package 1 explicit replacement
precedes a separate real-Electron presentation-layer prototype proof before broad
wiring. Authorization covers tested PRs; no merge, release or parity claim.
**Related:** [ADR-0032](0032-named-workspace-runtime-switching.md), [ADR-0037](0037-base-row-resubmission-recovery.md)
**Delivery:** Design Task `a4d381de-b855-462e-b354-0e507eba161f`; parent Task `93f1491d-7139-4451-885c-fc34c4c30780`; Solution `ac76d20b-1183-4698-af07-21e3d0560dfe`

## Context and evidence

At diagnostic commit `4a98c02`, based on Canvas `2a0c6f4`, the coordinator ran
the unchanged tests in real Electron. Reading and Live Preview each reached a
real nested Base input through click followed by Enter and saved its value: two
entry tests passed. Double-click entry failed in both modes. Those entry failures
are a separate defect; they do not invalidate the successful keyboard witnesses.

Three further probes each established an actual input containing `9` and checked
the original source bytes before its lifetime action. Reading refresh and Live
Preview source reconfiguration disconnected the captured input. After Live
Preview scrolled away and returned, no reachable input with that draft remained.
These are valid lifetime regressions. Their first post-action assertions failed
before the final disk assertion: they establish lost connected/reachable controls,
not post-action byte loss. Screenshots/error contexts were retained, but the list
reporter did not persist inline attachment bodies. No event trace is claimed.

Source inspection at `7e66f7b` explains the incompatible ownership boundaries:
`MarkdownView.renderReadingNative` starts void disposal and clears Reading DOM;
`toggleSource` synchronously reconfigures the editor; `buildEditor` destroys the
previous CM view. Live Preview creates note/Canvas native subtrees inside
`EmbedWidget.toDOM`, while its void `destroy` starts scope close. Decorations are
built over visible ranges. A widget destructor cannot veto CM virtualization or
make detached controls reachable by retaining their scope in memory.

ADR-0037's Base edit/projection guard is a separate prerequisite. It may resolve
an entry or refresh problem; it does not make an externally removed CM widget
durable. Existing Canvas reconciliation remains owned by its source package.

## Constraints and desired outcome

- Keep existing editable native note/Canvas embeds, including nested Base writers.
- Before an explicit replacement refuses, preserve the same connected actual
  draft/recovery controls and cause no incidental child write through blur.
- Scrolling, measurement and virtualization are presentation changes, not user
  authorization to save or discard a child draft.
- Keep owner/generation checks, failed-write acknowledgments and vault conflict
  policy. Never introduce a second independent root for a native descendant.
- Register producers before awaits; preserve late-mount cancellation and close
  exactly once. No dependency or plugin-facing interface change.
- This is a lifecycle prerequisite, not a complete Markdown/Workspaces parity claim.

## Options considered

| Option | Benefit | Cost or limitation |
|---|---|---|
| Await explicit replacement; keep native DOM in a view-owned layer with CM placeholders (recommended) | Preserves inline editing and reachable offscreen recovery independently of virtualized widget lifetime | Needs occurrence identity, measurement, retained-presentation layout and real focus testing |
| Keep native DOM in CM and pin decorations or disable virtualization | Familiar inline DOM/event ancestry | A void destroy still cannot veto removal; relying on dirty-widget survival is unsafe; rendering a whole long note changes performance substantially |
| Read-only embedded previews with explicit Open interactive pane | Smaller durable ownership boundary; ordinary leaf lifecycle owns editing | Removes existing inline editing and changes the desired behavior; retain as an explicit fallback if the proposed layout cannot meet its proof gate |

## Decision

Recommend two cooperating boundaries: awaited explicit Markdown replacement and a
MarkdownView-owned persistent presentation manager for native-capable Live Preview
embeds. A CM widget owns an anchor/placeholder, not an interactive native subtree.
Reading retains its ordinary DOM but must prepare retirement before replacing it.

### 1. Stage explicit replacements before changing their visible owner

Use one serialized native transition coordinator per MarkdownView. Cover Reading
refresh, live/source/Reading transitions, file replacement, editor rebuild,
accepted external text, navigation that leaves Reading mode, and ordinary close.
Inventory their actual callers, including actions, callbacks and fire-and-forget
paths. A sync callback may schedule an observed asynchronous transition; it must
not mutate file/mode/DOM first and await preparation later.

1. Capture owner, vault object/root, current file/editor, mode and transition
   generation. Determine the complete affected Reading roots and LP presentations.
2. Preflight before changing mode/file/title/selection, hiding the owner, focusing
   a toolbar/editor, destroying CM, or clearing DOM. Refusal leaves controls
   connected and presents a Finish/Cancel/Retry explanation. An explicit command
   must not first blur the draft to make its own preflight pass. Ordinary user
   focus transfers retain their documented Base save behavior.
3. Settle the parent Markdown save and prepare the affected descendant scopes
   through existing `prepareDisposal`/`RenderScope.prepareRetirement`. Check
   identities across awaits. Do not prepare/drain the same root operation that is
   currently awaiting this transition: that would await itself. Coordinate child
   scopes while the view transition owns its parent operation.
4. If preparation fails before destruction, abort/resume the complete affected
   set, keep the original file/mode/editor/DOM and preserve reachable recovery.
   Already successful authorized writes remain successful; do not restore stale
   bytes. A stale transition must not publish into a newer owner.
5. Only after successful preparation commit retirement, then change the staged
   projection. A later render failure is a visible render error, not a rollback
   guarantee for already destroyed native views. Keep the source buffer and saved
   bytes available; partial destructor failure remains fail-closed per ADR-0032.

Automatic Reading refresh can coalesce while a draft prevents retirement, rather
than repeatedly remove or rebuild it. Show a local pending-refresh state. Native
finish/cancel/retry completion may send a private readiness hint to the owning
view, which rechecks the actual retirement condition before retrying current
refresh data. The hint is not permission to clear failures. Do not infer readiness
from a generic metadata event alone or retain a stale queued render result.

### 2. Own interactive LP DOM outside CM-managed content

Create one presentation layer as a stable connected child of the MarkdownView's
editor host, outside CM's managed content/virtualization DOM. Each record allocates
its own stable presentation root under that layer. From its first mount onward,
the native Canvas/note subtree stays under that same root and parent. Do not move
its DOM through the placeholder, a detached fragment, or a recovery panel.

The CM replacement widget contains only a measured placeholder and inert loading
or unavailable text. The presentation root is positioned over the placeholder
within the owner pane's clipped viewport. A pointer-transparent layer and
pointer-enabled presentation preserve interaction without intercepting unrelated
editor text. Preserve the actual owning leaf for links and pane activation;
global active-editor state must not be guessed from an overlay's DOM ancestry.

Register the record and its child RenderScope synchronously, append the native
presentation to the connected layer, then start asynchronous reads/mounts. This is
also the required future PDF seam: `PdfFrame.open` requires a connected container,
and a detached-await startup has already failed in the PDF package. Do not await
native startup before insertion. Preserve cancellation, generation checks and any
App-owned PDF admission/byte limits; this ADR does not implement PDF embeds.

Use CM's measurement scheduling plus pane/placeholder size and scroll observations
to update geometry. Separate reads from writes and coalesce each record's updates;
avoid a resize/height feedback loop. Placeholder height comes from the presentation
with a stable loading estimate, so virtualization does not collapse layout or
change document content. Resizing a pane and zooming must not recreate a writer.

### 3. Stable occurrence identity and asynchronous reconciliation

Key records by owner/editor lifetime plus a distinct source occurrence identity,
not target filename alone. Repeated identical embeds own independent views. Map
known source intervals through CM changes; reuse a record only while its full
presentation identity remains compatible (source context, target/subpath/params,
kind and occurrence). A new widget generation attaches a new anchor lease to the
same compatible record. A stale destroy cannot clear its successor's lease.

`Widget.destroy` only releases its exact anchor lease and requests reconciliation.
It does not close or detach the interactive subtree. Selection revealing raw embed
syntax, viewport removal and compartment destruction are not reliable reasons to
assume the native record is clean. Serialize retire/reacquire per record; if a
clean retirement is already committed, a returning anchor starts a fresh record
after it completes. Never publish into or resurrect the retired generation.

If source editing removes/retargets an occurrence through a synchronous CM change,
do not reuse its old record for the new target. Retain an unresolved old draft as
an explicitly labelled removed-embed recovery presentation until safely finished;
its original child target remains authoritative. This avoids rewriting/replaying
the editor's transaction or undo history from a void destructor. Explicit file,
mode and owner replacement still use the awaited refusal boundary above. A retained
record with no valid source anchor has no misleading Return-to-embed action.

### 4. Reachable retention, offscreen behavior and bounded cleanup

When a native anchor goes offscreen, preserve an active draft, failed write or
unfinished retirement in the same connected presentation root. Reposition that
root using CSS into a visible retained-embed shelf in its owning pane. Include an
accessible source/target label and Return to embed when its mapped anchor remains
valid. For several retained records use a bounded-height scrollable shelf; do not
hide a failed record behind an unreachable selector or silently drop older drafts.
Use ordinary focus navigation and the actual child's existing Finish/Cancel/Retry
controls. Do not duplicate the input, clone its state or implement a second save.

Scrolling alone must not call focus/blur, hide the focused element with display
none, mark it inert, or reparent it. Returning scrolls to the current mapped
occurrence and repositions the same root; it does not recreate the writer. Normal
explicit focus transfer to a button can invoke the existing blur-save policy.
Switching to another tab may hide the owning pane normally; returning to that tab
must restore its retained controls. Closing/replacing the owner still prepares all
records, including offscreen and removed-anchor records.

Clean offscreen records should retire through the same awaited child preparation
and close exactly once. Keep pending mounts tracked until canceled/settled, with
no late DOM publication. If preparation refuses/fails, retain the connected root
and reachable local recovery instead of deleting its registry entry. Remove a
record only after successful close. Coalesce tasks per record; do not accumulate
an unbounded queue of scroll-triggered operations or permanently cache every
visited clean embed. Retention is proportional to visible and unfinished user
work, not a claim of a global memory/CPU bound. A future resource limit must refuse
new admission visibly, never discard an existing unfinished record.

## Consequences and risks

CM virtualization remains enabled. Native edit lifetime follows the Markdown
owner rather than incidental widget DOM. Explicit replacement becomes asynchronous
and can refuse while the original editor remains usable. The price is a measured
presentation layer and an occurrence registry, not a new renderer framework.

The riskiest assumption is that overlay/placeholder geometry, nested scrolling and
keyboard focus remain stable across CM measurement, zoom, tab visibility and pane
resizing. Prove that in a focused real-Electron layout prototype before broad
wiring. If it cannot preserve connected interaction and normal text editing,
return for the explicit read-only/Open pane tradeoff rather than weaken lifecycle
guarantees. No new layout system or dependency is recommended.

Plugin MarkdownRenderChildren and ordinary media keep their existing semantics
unless the owner-replacement inventory finds another native writer. Legacy void
`MarkdownRenderer.dispose` remains a compatibility entry point; native owners
must use the awaited boundary. No claim about arbitrary third-party writer
quiescence follows from this native implementation.

## Bounded engineering packages and acceptance

1. **Explicit replacement:** implement the view transition coordinator and audit
   every replacement caller. Reproduce Reading refresh and source-mode valid REDs
   before changes; check refusal before mode/file/title/DOM/focus changes, delayed
   parent flush, preparation failure, late reads, and stale transitions. Keep the
   current connected input/recovery controls and exact original bytes before an
   explicit refused action; no incidental child blur write.
2. **Persistent layer prototype and record ownership:** one real native Canvas
   containing a note/Base, then two repeated occurrences. Actual keyboard entry,
   typing, child navigation, resize/zoom/scroll, duplicate occurrence identity,
   placeholder measurement and pointer/keyboard accessibility. Mount connected
   before startup; race pending mounts and returning/replaced anchors. No CM source
   or undo changes from measurement. Independent architecture review before broad
   native embed wiring if the positioning contract changes materially.
3. **Virtualization/recovery integration:** run the original valid offscreen/return
   witness, then failed writes and Retry with the same connected native root,
   active input and exact draft. Test source retarget/removal, cursor revealing raw
   syntax, mode reconfiguration, scroll away during mount, repeated viewport churn,
   tab switch/return, ordinary close, file change and vault/root switch. All retained
   records participate in owner preflight; refusal preserves controls, success
   closes once, late callbacks stay canceled. Clean records do not grow with every
   visited viewport. Exercise small panes and multiple retained presentations.
4. **Combined verification:** rerun Base ADR-0037 and Canvas owned-presentation
   failure/history suites, source editing/undo/autosave, typecheck/build, then
   coordinator-serialized full gates and independent review. Preserve screenshots,
   explicit JSON files or a reporter that actually stores attachments, exact
   source commits, and assertions of bytes after every lifetime action. A detached
   captured input containing `9` is not successful recovery.

The double-click entry defect remains separately tracked until reproduced and
fixed with its own evidence. Existing originals and diagnostic checkpoints stay
unchanged; do not reinterpret earlier failed entry tests as ownership proof.

## Accepted addendum: ordinary close of an external-recovery note

**Date:** 2026-10-15. Accepted by coordinator under the user's reversible tested-PR
authority: exact current-snapshot receipts from actual existing preservation or
validated restore only, no automatic close writes. No implementation, merge,
release or parity claim is included.

### Problem and existing evidence

The native root currently reuses `assertWorkspaceLoadReady` for ordinary close.
That strict named-layout check refuses every `conflictReadOnly` note. Simply
removing it would allow destruction of the only memory copy of a local edit.
The older provider-write regression calls `presentConflict`, then changes the CM
buffer programmatically and expects navigation/close to succeed. It verifies the
provider guard but establishes no durable recovery copy of that changed buffer.
Its provider-byte assertions remain valuable; unconditional successful close is
not a safe expectation for that fixture.

At `7e66f7b`, `presentConflict` sets a boolean/read-only banner and captures local
text for Copy local version; it does not retain a durable-copy receipt. Its
`recoveryLocation` default is `device`, so a call or banner alone is not evidence
that storage exists. `App.prepareConflict` actually awaits `vault.create` for a
conflict copy, or falls back to `localStorage.setItem` of vault/path/text. Restore
reads a record and rebuilds the view. Neither presentation arguments nor the
restored banner record which exact current buffer has been preserved.

### Options and recommendation

| Option | Benefit | Cost / limitation |
|---|---|---|
| Refuse all recovery notes on ordinary close | Smallest conservative rule | Unnecessarily blocks a local edit already preserved exactly in existing recovery storage |
| Validate an exact preserved snapshot before ordinary retirement (recommended) | Allows safe ordinary close after actual existing preservation while retaining memory-only recovery | Needs a small private receipt and async validation in the existing preparation phase |
| Automatically save a new recovery copy on every close | Could create preservation when none exists | Adds a write/ownership/failure protocol and changes close semantics; outside this bounded decision |

Keep strict named-layout readiness unchanged: any unresolved external recovery
still refuses layout loading. Introduce separate ordinary-retirement readiness
for buffer-destructive navigation/file replacement and close. It may allow a
recovery note only when the exact current local snapshot has confirmed existing
preservation. All nested writer preflights, provider flush guards and ownership
generation checks remain mandatory. A mode action that retains the same local
buffer must still honor the accepted child-projection boundary; this addendum does
not grant it permission to discard recovery or bypass descendants.

### Minimal private recovery evidence

Add private per-view evidence containing the captured Vault object/root, source
file identity/path, exact local buffer text and the preservation destination:

- A distinct conflict-copy TFile/path returned by the successful existing
  `vault.create`, belonging to that same Vault.
- Or the exact existing device-recovery key and vault/path/text record successfully
  stored and read back through the current device storage mechanism.

Mint evidence only from the actual successful App preservation/validated restore
path, with captured identities and text. Do not mint it from `presentConflict`'s
booleans/path arguments, a default location label, a clipboard copy, or an assumed
successful fire-and-forget operation. The existing create/store operation may have
captured text before an await while the live buffer changed; its evidence must
describe the stored text, not the newer text currently displayed. A receipt whose
text does not match remains insufficient for close.

Invalidate evidence on owner/file/root replacement or recovery reset. Every close
check also compares the current buffer exactly, so direct CM changes after
presentation cannot reuse old preservation. Use narrow private internal integration
seams; no new public plugin interface is required. No automatic recovery write or
global acknowledgment is introduced by closing.

### Ordinary retirement sequence

1. Synchronous preflight refuses memory-only, absent, stale-owner or text-mismatched
   evidence before blur, CM destruction, navigation publication or DOM removal.
   Preserve the same connected local buffer and its recovery controls with a clear
   explanation. Dismissing the banner does not resolve the recovery state.
2. In the existing awaited prepare phase, validate the captured destination. For a
   conflict copy, require the same current indexed copy object at its distinct
   captured path, then read and compare exact preserved text. For device recovery,
   reread/parse the exact record and require matching vault/root/path/text. Missing,
   changed, malformed or unreadable preservation refuses. The validation performs
   no provider/local recovery writes.
3. Recheck current view/Vault/source identity and local text after awaits. Continue
   all descendant preparation. On pre-destructor failure retain/resume the old
   connected tree and controls; do not fall back to allowing close because provider
   `flush` is suppressed. On success ordinary retirement can proceed without ever
   flushing the local recovery buffer over provider bytes.

Device storage confirmation uses the existing browser storage contract; it is not
an fsync, backup or permanent-storage guarantee. Concurrent external deletion of
a conflict copy after validation, storage clearing, raw trusted-plugin mutations,
and cross-process races are not made atomic by this receipt. Do not claim those
guarantees. Keep any validated recovery record/copy after close for its existing
restore/open mechanism; closing must not delete its only preservation.

### Required regression paths

- Preserve every original provider-byte assertion: navigation, ordinary close and
  Reading-related preparation must never publish the local recovery buffer.
- A memory-only/unconfirmed note with an actual local edit refuses destructive
  navigation and close, retaining the exact connected buffer and reachable Copy
  local/recovery controls. Assert bytes separately after refusal; do not replace
  the old test with only `expect(...).rejects`.
- Through actual existing preservation, create and validate an exact conflict
  copy, then demonstrate successful ordinary navigation/close and readable exact
  local copy, while original provider bytes remain unchanged.
- Exercise successful device storage and restore evidence separately. Failed or
  missing record, wrong vault/path, and a subsequent edited local buffer refuse.
- Delete/recreate or modify the conflict copy while preparation is delayed; stale
  identity/bytes refuse before destruction. A later independently valid copy can
  establish new evidence; no stale receipt or clipboard action can.
- Even a valid own-note receipt cannot bypass a descendant Base/Canvas draft,
  failed write or pending producer. Named-layout readiness stays strict after an
  ordinary-close receipt is valid. Normal no-conflict close still succeeds.

Require regression-first source work, independent review and coordinator-run real
Electron evidence. No restored legacy behavior, data-loss fix or parity completion
is claimed by accepting this policy alone.

### Accepted rename preflight clarification

The coordinator additionally authorizes a narrow own-recovery preflight before
rename storage mutation. Gather every open affected Markdown view, including
multiple splits of the renamed file and reference files that will be rewritten;
do not rely on a single `findLeafForFile` result. The common rename preflight
strictly refuses if any such view has unresolved Markdown recovery, even with a
currently valid receipt. Rename changes the captured source path and can strand
that receipt; no validation, automatic retargeting or new receipt may waive this
narrow refusal. This preflight creates no recovery copy, flushes no recovery
buffer and clears no conflict state. Normal clean rename remains available.
It supplements, rather than replaces, the nested projection retirement checks
when a view actually changes. A later child-refresh refusal does not roll back
already successful storage writes; never restore stale bytes or claim atomicity
against external writes or host rename races.
