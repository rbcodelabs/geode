# ADR-0045: Source-owned native Markdown integration

**Date:** 2026-10-15
**Status:** Accepted by coordinator on 2026-10-15 under existing reversible tested-PR authority. Sequence1 source-owner navigation is the current bounded implementation package; subsequent increments remain separately scoped. No merge, release or parity evidence.
**Parent:** ADR-0038, durable native Markdown presentations.
**Traceability:** Task `5ebcf1f8-5fab-421f-8ab8-1989300588b7`; Solution `ac76d20b-1183-4698-af07-21e3d0560dfe`. Bounded source-owner navigation Task `707fbc6c-3509-49ea-a516-f8ce984c56b8`, owner root/outgoing_delivery.

## Context

The private persistent layer demonstrates a viable ownership mechanism independently of CodeMirror widget removal. It does not yet own production Markdown projections. This decision defines the next integration boundary so actual document actions cannot bypass its lifetime policy.

Source reviewed at private checkpoint `8c06c4352d36cde53b5a4201b4944ac72bdba53b`. Full 23-case/unit gate `01M505QCS9A809R4G7TCQAVQD0` was running when the proposal was prepared; it subsequently passed338unitfiles/4902tests+3existingbenchmarkskips andall23actualcases0retry, manifest1f48510e5c1c04dc750a53ea26cb4d6bf389d8fa3f98d6c9284f5bc08db5fe7e. This is bounded private prototype evidence only. Prior verified height/recovery evidence remains a distinct checkpoint. Preserve every failed experiment and the original production offscreen/return RED.

Actual child-navigation evidence shows pointer blur committing Source `2` to `9` before replacement; the recorded callback had no explicit source leaf. Clean fresh/reused-destination fixtures subsequently pass effective routing, but the edited-draft link was clipped before its trusted hit. Neither result proves pre-blur refusal. The real workspace `focus:false` hide/return keeps root and parent connected but Chromium blurs the input; current application blur policy commits `9` and removes the edit input. Browser blur and application authorization to commit are distinct facts.

The parent requirement is still editable native embeds with safe unfinished work, ordinary explicit saves, exact source ownership, and reachable recovery. Public Editor and Workspaces production implementations are outside this package.

## Constraints

- No new dependency or public SDK signature change; existing raw trusted-plugin access is not made a security boundary.
- One native writer/root per occurrence, connected before asynchronous mount. Keep the same parent until successful retirement; never clone or reparent a draft into recovery.
- Preserve existing RenderScope freeze, prepare, validate, commit and abort/resume semantics and per-leaf document queue.
- Ordinary deliberate focus transfers retain Base blur-save behavior. Scrolling, geometry, virtualization and programmatic background hiding grant no new save/discard authority.
- Capture Vault object/root, source file/editor generation and occurrence identity; recheck after awaits. No transition may publish into a replaced owner.
- Preserve current Canvas cameras and independently owned descendant target files. Provider save acknowledgment and visual projection refresh are separate assertions.

## Options considered

| Option | Benefits | Cost / limitation |
|---|---|---|
| Explicit private owner context and typed navigation/visibility intents (recommended) | Inspectable propagation; synchronous pre-blur gate; existing queued retirement reused | Requires internal constructor/render options and audit of trusted event paths |
| Resolve nearest scope/DOM owner at event time and intercept globally | Fewer explicit arguments; centralized interception | Scope describes disposal rather than a unique source leaf; overlay and transclusion ancestry do not identify the intended owner reliably; global event exceptions are hard to audit |
| Remove interactive embeds and open separate native panes | Smaller lifetime and focus problem | Changes accepted functionality and abandons inline interaction; only a separately approved fallback if geometry cannot satisfy acceptance |

## Decision

Adopt the explicit private context approach, retaining ADR-0038's stable layer. Deliver it in separately verified increments, not a wholesale rewrite of RenderScope or Workspace.

### 1. Propagate a lazy source-owner context

Thread a private context from the owning MarkdownView through Live Preview/Reading renderer, Canvas, nested rendered notes and Base-origin links. Resolve the actual WorkspaceLeaf lazily, as MarkdownView.ownLeaf already does, so moving a tab does not cache an obsolete pane. Include source owner/lifetime checks and navigation-intent dispatch; do not encode the target file as the source owner. The native child keeps its own file for rendering and writes.

Standalone Canvas supplies its own current workspace leaf resolver. Nested Canvas inherits the outer document's source context. Sidebar or detached native contexts must explicitly supply their owner or refuse destructive in-app routing while unavailable; never fall back silently to the active global pane. Retain ordinary existing global-active behavior for unrelated public API callers outside this private boundary.

Relevant seams: `markdown-view.ts:229` ownLeaf, `:241` projection preflight, `:324` buildEditor, `:872` Reading render; `live-preview.ts:944` embedded Canvas construction; `render.ts:700/717/755` Base/Canvas construction; `canvas-view.ts:707/918` currently omitted renderer origin; `render.ts:539` rendered child-link callback. Engineer must audit Base-generated file links as well as nested Markdown links, rather than assume all links share one handler.

### 2. Recognize an explicit navigation intent before incidental blur

A private intent records source owner, captured lifetime/Vault, requested destination/subpath, modifier/new-tab policy, and reason. It is a request, not an authority receipt and not proof that retirement succeeded.

For trusted pointer navigation, the handler must synchronously identify the actual internal link and invoke owner preflight before browser default focus transfer or pane activation. If preflight refuses, prevent the action and its incidental focus change, display existing reachable finish/cancel/retry guidance, and leave exact provider bytes and original controls untouched. Do not suppress unrelated pointer interactions. Capture/propagation handling must prevent duplicate nested handlers, preserve modifiers, and avoid globally consuming links.

On allowed pointer navigation, prevent default incidental focus while the observed async request runs. Keyboard activation passes through the same private intent API; moving focus to a link beforehand remains an ordinary deliberate focus transfer and must be tested separately, not mislabeled as pre-blur protection.

Inside existing leaf serialization, revalidate the intent and synchronously preflight the complete production projection set again. Only then stage destination work, prepare descendant retirement, validate current identity, commit and publish. Include destination reuse, new tab, subpath reveal and unresolved-link creation: current `App.openFile` existing-target branches activate a leaf before loading, and `openLink` creates missing storage before opening. A refused source-owner action must not activate another leaf, move the cursor, create a missing note or change history first. Preserve existing valid behavior after successful authorization.

Use the existing transition owner to retire descendant scopes; do not drain the parent scope operation currently awaiting that same transition. Refused/failed preparation resumes the complete affected forest, leaves file/mode/title/history/DOM unchanged, and observes all errors. Successful authorized writes are never rolled back to old bytes. Partial destructor failure remains fail-closed.

Relevant seams: `App.ts:4860` routing and destination reuse; `:4905` serialized opening; `:5230` resolution/create/reveal; `workspace.ts:459` leaf queue; `markdown-view.ts:248` replaceProjections; `workspaces/render-ownership.ts:114–149` forest prepare/commit/preflight. Exact line numbers are checkpoint references, not stable future interfaces.

### 3. Clarify background visibility policy explicitly

The original no-implicit-blur experiment remains failed. A real hidden Chromium host cannot promise that the old input remains document.activeElement. Do not replace the test with synthetic hiding or silently waive its provider-byte/input-retention assertions.

Accepted ADR-0038 clarification: for actual programmatic background activation with `focus:false`, preserve the unfinished native edit session, same connected input/root/parent, exact draft and provider bytes, while permitting a recorded browser blur. Mark the source owner as undergoing a background visibility transition synchronously **before** changing host visibility. Base/native blur handling consults that private cause only to avoid incidental commit; it does not clear failures, synthesize completion, reacquire focus in another pane, or grant close readiness. Persist the state through the known hidden interval and clear it on actual reveal/aborted transition, with owner/generation checks. Do not use an arbitrary timer or a one-shot global ignore-next-blur flag that could consume unrelated deliberate interaction.

Trusted deliberate tab activation must be distinguished at its event boundary and retain the current normal focus/blur save policy. Cover drag/move, repeated activation, hidden-owner close, new foreground focus, failed save, and overlapping background requests. On return, expose the same original edit controls and recompute geometry; focus restoration is conditional on user focus ownership and must not steal focus from another pane. Actual window deactivation/OS blur requires separate characterization; this proposal does not generalize the tab-hide exception to every blur with null relatedTarget.

Coordinator explicitly accepted this clarification on2026-10-15: browser blur may occur, but programmatic background activation must cause no incidental application write and must preserve the same connected input/draft/provider bytes; deliberate trusted tab transfer retains ordinary save. Implementation is a later bounded package. It changes an impossible browser-focus invariant into a precise application no-save invariant, preserving the intended unfinished-work behavior. It requires no irreversible product action or new user approval under the existing broad authorization.

### 4. Integrate stable roots with production projection lifetimes

After the navigation/visibility guards are verified, allocate the manager as a stable MarkdownView-owned host sibling of CM content. Production lpProjection owns manager record child scopes, including visible, offscreen, removed-anchor and pending-mount records. Reading keeps its existing ordinary projection scope and awaited retirement. Replace only native-capable LP widget subtrees with occurrence-bound placeholders/anchor leases; ordinary images/media/plugin render children remain on existing semantics unless separately inventoried as writers.

Production occurrence mapping must handle complete source identity, duplicates, retarget/removal and undo. Adopt verified measured-height prefix layout, stale lease checks, held-retirement and no-resurrection behavior without copying the private fixture's hardcoded sizing as product policy. Native owner lifetime must outlive anchor leases and be retired exactly once by the actual Markdown transition. Never leave manager scopes as test-only siblings outside projectionScopes.

Geometry changes must not dispatch source/history edits. Placeholder effects, pane scroll/resize/zoom and native height updates coalesce reads and writes. Preserve each Canvas camera and descendant parent. Background panes may measure zero: defer presentation geometry until reveal instead of overwriting valid dimensions or retiring writers because their host is hidden. Explicit replacement prepares all records before CM rebuild/destruction, not afterward.

## Bounded sequence and verification contract

1. **Next ready package: source-owner navigation guard.** Start with a real production rendered child link and visible actual native draft. Record original exact Source `2`, original input/root identity, literal link hit and route leaf. Reproduce actual blur/write/replacement RED before changes. Cover clean allowed navigation and fresh/reused/new-tab/missing target, then root+independent review and actual frozen Electron proof. No persistent-layer wiring yet. If link clipping blocks the draft witness, correct fixture positioning with review and rerun; it is not a passing refusal.
2. **Background visibility cause.** After accepting the clarification, reproduce current real workspace focus:false Source `2`→`9` RED. Assert browser blur separately from no application write, input/root identity and exact draft after hide/back; keep trusted deliberate tab-save positive control. Test overlapping requests, disposal and no focus stealing.
3. **Production LP ownership.** Wire production scopes/anchors/measurement using the verified private mechanism. Rerun unchanged original production viewport/return regression and Reading/source-reconfiguration witnesses. Add duplicate embeds, 400/200 retention, actual pointer Retry/Cancel, pending startup, retarget/undo, returning anchor during held retirement, stale leases, failed prepare/close, file/mode/vault replacement, current source history and exact provider bytes after each lifetime action.
4. **Independent remaining behavior.** Diagnose compact Base controls and stale clean projection (`provider9`/rendered`2`) with controlled actual metadata/query timing. No fixed height cap, arbitrary poll, forced scroll/camera reset or relaxed screenshot may conceal these failures. Verify clean sibling refresh without replacing dirty sibling inputs. A material new compact interaction/layout needs a reviewable visual reference; accepted shelf behavior alone does not approve a toolbar redesign.
5. **Full integration gate.** Pin a combined exact source SHA including native prerequisites and accepted replacement guards. Run complete types, normal/private builds, units, full real Electron suite and original Base/Canvas failure/history suites through testq. Assert actual selected test counts, archive and verify manifests/source hashes, inspect state JSON and relevant screenshots, record skips/retries honestly. Independent full-diff/privacy review precedes a tested PR. A focused prototype pass or latest-main textual merge does not substitute for this gate. Preserve all prior negative evidence in the report and Compass Task.

## Consequences

Source actions gain an explicit, inspectable owner and refusal boundary. Existing per-leaf serialization and scope retirement remain authoritative. More internal callers need context, and event ordering becomes a tested contract. This is preferable to DOM ancestry guesses or a global blur exception. It does not provide atomic multi-file writes, arbitrary plugin quiescence, OS focus guarantees or complete parity.

## Risks and revision triggers

The riskiest assumption is that every native-origin destructive action can be intercepted before browser focus and application publication while preserving ordinary deliberate focus semantics. A missed keyboard/pointer route, synchronous plugin entry, destination-reuse shortcut or hidden-owner transition can invalidate that assumption. Audit actual callers, not only matching strings. Trusted raw plugins can bypass private protections; document this limit rather than add an unproven sandbox.

Revisit architecture if source-owner routing cannot remain unambiguous across moved/sidebar leaves; if projection scope preparation deadlocks a parent operation; if measured overlay positioning materially changes; or if compact controls cannot remain reachable at supported pane sizes. Return for an explicit alternative before removing editable embeds or weakening original data/lifecycle assertions.

Routine implementation and test-only fixture corrections remain within reversible authorization. Public SDK breaking changes, replacing interactive embeds with read-only previews, new paid infrastructure, merge/release, data destruction or external messages require broader explicit authority. No such action is recommended here.
