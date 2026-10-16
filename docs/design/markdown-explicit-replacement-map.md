# Markdown explicit replacement: ADR-0038 package 1 map

**Date:** 2026-10-15
**Scope:** Design/caller inventory only, frozen source `7e66f7b` (Canvas branch).
**Authority:** Accepted [ADR-0038](../adr/0038-durable-native-markdown-presentations.md), design Task `a4d381de-b855-462e-b354-0e507eba161f`, parent `93f1491d-7139-4451-885c-fc34c4c30780`, Solution `ac76d20b-1183-4698-af07-21e3d0560dfe`.

Line references below describe that exact source, not later Base/PDF integration.
No app/test run or new lifetime evidence accompanies this inventory. The existing
three valid lifetime REDs remain the evidence recorded in ADR-0038. Persistent
layer/virtualization work and its real-layout prototype are a separate package.

## Replacement entry points

All methods below are in `src/renderer/views/markdown-view.ts`.

| Entry / frozen line | Current effect | Required package 1 boundary |
|---|---|---|
| `setFile` 213 / `setFileNative` 217 | Root-owned async flush/read, then file/title/breadcrumb/conflict state changes, `buildEditor`, optional Reading render and focus | One view transition; capture target and current identities, preflight existing projections before flush/focus/state changes; await read with guards; prepare entire affected set before publication |
| `buildEditor` 252 | Destroys existing CM immediately | Commit-only private primitive; never a second independently queued operation from inside a transition |
| `acceptExternalText` 576 | Clears recovery state, changes saved text/line ending, rebuilds, starts Reading render without awaiting | Awaitable internal transition; defer/refuse safely while nested edit exists; keep conflict arbitration and saved-snapshot semantics; observer adapters must observe its result |
| Provider button 619 | Calls `acceptExternalText` from click | Observed async adapter; do not clear banner before accepted replacement; preserve ordinary focus semantics and exact original provider payload |
| `restoreConflictRecovery` 653 | Changes known saved text, rebuilds local recovery buffer, presents conflict and changes focus | Internal transition with no provider write; startup caller awaits it; do not overwrite a live nested edit because recovery was found late |
| `toggleMode` 735 | Changes `mode` before render, then hides/shows/focuses | Stage desired mode; preflight before changing mode or focus; await retirement/render and commit mode only at the safe point |
| `toggleSource` 743 | Changes mode and synchronously reconfigures LP compartment | Async transition implementation; explicit source reconfiguration preflights/awaits affected LP roots before CM can destroy widgets |
| `renderReading` 763 / native 775 | Root-owned flush, void-dispose previous Reading root, clear DOM, render replacement | Coalesced refresh entry; internal render helper runs inside current transition without re-enqueue; prepare old subtree before clear; new producer registered before awaits |
| `resumeOwnedRendering` 769 | Called synchronously from root scope resume; Reading starts async refresh, LP immediately reconfigures | Schedule a coalesced guarded readiness/refresh request; never synchronously destroy child projections while a failed barrier is resuming them |
| `revealComment` 437 | Forces live mode/reconfiguration and selects/focuses CM | Route mode/reconfiguration through transition first; re-resolve thread against current owner buffer afterward; no stale captured offsets published into another note |
| `scrollToOffset` 798 | Leaves Reading mode immediately and focuses/selects retained CM | If mode change is needed, use transition first; then clamp/select current buffer under captured owner check; same-mode scroll remains lightweight |
| `onClose` 903 / `closeNative` 907 | Root close prepares descendants, then CM destroy and Reading disposal | Terminal owner operation, not a root-owned queued transition awaiting its own close; ordinary leaf close must preserve DOM on refusal; close primitives only after preparation |

`applyMode` 756 is a commit-only visibility/focus primitive. Its other callers are
the entries in this table. `onOpen` 887 and `onReveal` 899 focus/measure, but do not
replace projections; retain their startup/background-tab behavior. Formatting,
comment insertion/bookmark writes, and ordinary CM document edits do not rebuild
the editor here. Synchronous source edits can still cause LP widget removal; that
is package 2's durable-layer problem, not solved by this explicit caller gate.

## External caller map

Paths are relative to `src/renderer`.

| Caller | Chain / required adaptation |
|---|---|
| App document navigation `app.ts:4890–4953` | `openFileInLeaf` → leaf navigation queue → `mountDocumentInLeaf` → existing Markdown `setFile`, or `initializeDocumentView(new MarkdownView)` → `setFile` → `leaf.setView`. Preserve history publication only after accepted load; preserve unpublished-new-view cleanup on read/old-view-close failure |
| Plugin file open `workspace.ts:365–377` | `WorkspaceLeaf.openFile` awaits mount, then optional `view.scrollToOffset` for subpath and restores background focus. Its current optional interface returns void; native awaitable reveal needs an observed adapter/awaited native path, with background focus restored after the actual reveal, not before it finishes |
| Back/forward `workspace.ts:445–495` | Leaf queue → `openFileInLeaf(...alreadySerialized=true)`; do not enqueue again on the same leaf. Keep existing history index on refused view replacement |
| Workspace restore `workspace.ts:3702–3708` | `createMarkdownView` → await `setFile` → `leaf.setView`; initial detached view has no old projections to retire. Preserve supported pre-attachment initialization, but future persistent-layer/PDF startup must wait for its connected-host seam, not deadlock on detached initialization |
| Leaf replacement/close `workspace.ts:211,259,305,559` | `setView`, `setViewState`, `open`, `detach` await old `onClose` before removing its DOM. UI close sink 578 observes rejection. Multi-close 1234, deferral/unregistration 3432/3470, empty replacement 3952 ultimately use these methods; retain this ordering |
| Mode actions `app.ts:4594–4603,4646–4647` | Action registry already awaits returned promises; `createActionCommand` and header/menu callback adapters discard execution promises. Keep command availability synchronous/pure; observe execution failures with a local user explanation without claiming a boolean command result means async completion |
| Header controls `markdown-view.ts:142,148` | Click callbacks discard action promises. Guard before code-induced focus/hide; if refusing a pointer activation must preserve focus, preflight before the browser's default button focus. Do not add a global focus trap or stop normal unrelated blur saves |
| External modify `app.ts:3964–3984` | Waits pending own save, reads against stable known saved snapshot, then currently calls `acceptExternalText` without await. Await/observe replacement; preserve own-save echo suppression and current file/root checks across the newly asynchronous step |
| Reconciliation `app.ts:3839,3899,3928–3950` | Pauses autosave, stores `acceptExternalText` in refresh callback array, then awaits each before manifest/publication. Return the actual replacement promise; do not acknowledge reconciliation before required view handling, and do not clear the held recovery state on refusal |
| Recovery restore `app.ts:3792–3809` | Reads provider bytes and invokes `restoreConflictRecovery` void. Await replacement inside the existing per-record error boundary; distinguish a malformed record from a real native-lifetime refusal in diagnostics |
| Rename refresh `app.ts:5893–5914` | Renames storage and rewrites references before `await view.setFile(renamed)`. See the explicit limit below; never claim a later view refusal rolled back the already completed rename |
| Comment reveal `app.ts:5837,5859–5862` | Comment creation `.then` / open-file `.then` calls view reveal. Capture the intended leaf/file and await the native reveal; global active view can change during the new wait; catch failures at the UI boundary |
| Link/search/outline/bookmark reveal `app.ts:5225,5590,5613,5886–5889`, `views/search-view.ts:149`, `views/sidebar-views.ts:278` | All route through `revealOffsetInActiveMarkdownView`, which currently opens then reads global active view in `.then`. Resolve the intended current view and use observed native reveal; do not select another split/note after an await |
| Local file line links `app.ts:5133` | `openLocalFileLink` awaits open, then computes line/column and calls `scrollToOffset` void. Await native transition before returning its completed outcome; preserve background/source-leaf identity and bounds |
| Canvas `views/canvas-view.ts:283,717,920` | Canvas opens note files through `App.openFile`; embedded note cards call `MarkdownRenderer.renderNoteEmbed`, not `new MarkdownView`. Existing Canvas presentation retirement remains responsible for those renderer roots. Do not create a second MarkdownView/root or weaken Canvas preflight in package 1 |
| Renderer `markdown/render.ts:333,408,426,470` | Renderer scopes already track pending producers and await previous-scope close; public-compatible void `dispose` cannot authorize DOM removal. Use child retirement before Markdown owner clears content; legacy dispose after successful retirement is idempotent cleanup only |

`createMarkdownView` (`app.ts:5800`) is a factory only. Trusted plugins can call
the native view methods directly, so the view boundary itself must be safe; fixing
only App actions does not cover those calls. This inventory does not redesign
arbitrary third-party CM dispatch or custom writer protocols.

## Minimal ownership and queue implementation seam

Give each MarkdownView explicit private **LP projection** and **Reading projection**
child scopes under its existing root. Pass the LP generation scope to `livePreview`
and the Reading generation scope to renderer calls. Every native widget/mount is
already a descendant of the supplied owner. Retire the complete affected set with
one `RenderScope.prepareRetirement` call before any old projection is destroyed.
Do not sequentially close Reading and then discover LP refusal. No public scope
enumeration API or new independent registry root is necessary.

Create each new generation scope synchronously before producer startup. On commit,
close the prepared generation and only then destroy/reconfigure CM or clear Reading
DOM. Existing widget destroy/renderer dispose calls must be idempotent against
already closed child scopes. On abort, keep the old generation and its DOM, resume
only through the ownership contract, and recheck its parent's admission before any
further action. Package 2 will reuse this seam for durable LP presentation records.

The per-view transition queue must have failure recovery in its tail and must
validate owner/vault/editor/file/generation at execution and after awaits. Explicit
requests may be serialized with stale requests rejected; automatic refresh is one
coalesced current-data request, not an unbounded backlog. Do not blindly replay
several toggles/offsets captured for a previous note. Busy/stale refusal is visible.

Four lock-order traps require direct tests:

1. Queued `setFile` must call an internal Reading helper inside its transaction;
   awaiting newly queued public `renderReading` would wait for itself.
2. A transition registered in root `RenderScope.run` must not drain/retire that
   root; it would await its own registered task. Prepare only affected generation
   children. Public `flush` may track a nested root save; `flushInFlight` is a
   vault-write promise, not permission to drain the whole root.
3. Close must stop new requests/cancel obsolete queued work and run **outside**
   its own root-tracked transition. Do not hold a queue slot awaiting root close
   while root pending work is waiting for that slot. On pre-destructor refusal,
   restore usable admission; partial destructor failure remains fail-closed.
4. Scope resume callbacks cannot await a transition from the barrier that is
   synchronously invoking them, nor may they immediately reconfigure CM. Schedule
   a guarded/coalesced follow-up; a held registry must reject/cancel requests rather
   than leave root pending work waiting for that registry's release.

Workspace leaf navigation remains the outer navigation queue. A view transition
must not call back into the same leaf queue for its own continuation. Root/vault
switch and reconcile orchestration retain their existing coordinator ownership;
package 1 does not add a second global mutex.

## Failure and focus constraints

Preflight the entire affected subtree before intentional blur, mode/file/title
publication or DOM mutation. Parent flush failure preserves the original view.
Child preparation failure preserves connected controls and resumes the original
owner. A later native mount/render failure is accurately reported after destruction;
do not promise rollback of a destroyed view or rewrite successful saved bytes.
Only `ScopeCancelled` from obsolete work may be silently suppressed; real save or
retirement errors must reach the caller/UI. Keep external conflict/read-only guards.

Two source integration choices must be settled explicitly during root review:

- **Rename ordering:** source currently commits rename/reference bytes before
  refreshing the view. To promise refusal of the rename itself, preflight affected
  live projections before storage mutation. Otherwise retain/refuse the view
  refresh safely and report the already successful storage operation accurately.
  Do not expand this package into a filesystem rollback transaction.
- **Synchronous reveal adapters:** retain the internal View interface's existing
  void compatibility shape with an observed wrapper around a private async native
  reveal, or use the actual native promise at known native callers. No public API
  expansion is needed, but every known parent continuation/background focus restore
  must wait for its actual native transition. Record the chosen seam in the PR.

## Regression acceptance checklist

- [ ] Actual nested input `9`, original source bytes before action: Reading refresh,
  live/source/Reading transitions, same-view file change, external replacement,
  comment reveal and offset reveal refuse before detaching/changing the projection.
  Assert post-action bytes too; do not infer them from a failed control assertion.
- [ ] Delayed parent flush/read and child writes: refusal retains original
  file/title/mode/selection/undo/input/recovery controls; successful already-started
  writes remain acknowledged; Retry works, including unrelated retained keys.
- [ ] Mode/Reading/file transitions complete without self-drain or nested-queue
  hangs; rejected first request does not poison the next; stale queued intent never
  selects/rebuilds another note/split; no unbounded refresh queue.
- [ ] Failed preparation followed by root resume leaves real controls connected;
  resume schedules safe work and does not reconfigure their widget behind them.
- [ ] Ordinary tab close/replacement failure stays visible and observed; successful
  close runs descendants once, cancels late publication, and leaves no registry leak.
- [ ] Header pointer activation and keyboard commands exercise real focus order;
  normal explicit unrelated focus transfers still obey Base save semantics.
- [ ] Reconcile/recovery/external modify callers await actual outcomes; own-save
  echoes do not rebuild; read-only recovery never overwrites the provider note.
- [ ] Initial new/detached view load, background tab/subpath reveal, startup restore,
  existing history/menu/editor/native suites remain intact. A future connected-only
  native viewer must use the later connected-layer startup contract.
- [ ] Typecheck/build, targeted tests, coordinator-serialized actual Electron,
  independent review and full gates on the frozen integrated source. Preserve real
  JSON diagnostics explicitly. No claim that package 1 fixes CM virtualization:
  original offscreen/return RED belongs to the separate prototype/layer package.
