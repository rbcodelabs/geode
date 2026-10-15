# Canvas presentation ownership

Task `3b810c23-70d3-4bcf-9c3a-35796c868d66` → Workspaces task `93f1491d-7139-4451-885c-fc34c4c30780` → Solution `ac76d20b-1183-4698-af07-21e3d0560dfe` → KR `c3b390f0-92a8-479c-b629-2b6745d577d5`. Accepted design: ADR-0032 Canvas addendum `67fe0fd`. Starting source: `89de61c`. The user authorized reversible implementation through tested PRs; merge and release remain separate.

## Call-site inventory before implementation

All Canvas `render()` callers and direct owned-content replacements were inspected. Current `render()` replaces the viewport; tracking asynchronous disposal alone cannot preserve a focused embedded editor. This document classifies the intended change before implementation and does not claim the boundary is complete.

| Call sites | Presentation change | Required boundary |
|---|---|---|
| `beginNodeDrag`, `beginResize`, `moveTouchNode`, `rollbackTouchNodeDrag` | Existing node object and source remain; coordinates/dimensions change | Keep the entire connected wrapper and owned descendants; update geometry/selection/edges in place |
| `beginNodeDuplication` drag preview | Existing wrappers remain; new clone objects appear | Retain existing wrappers; allocate only clone presentations; stage clone removal on cancellation if it has descendants |
| `addTextCardAt`, `addFileCardsAt`, `addLinkCardAt`, `addGroup`, `duplicateSelection`, `addConnectedTextCard`, `addConnectedCard` | Add objects; existing presentations remain valid | Retain existing wrappers and scopes; register new presentations before asynchronous mounting; text-source entry uses its own boundary |
| `select`, `selectEdge`, `updateSelectionClasses`, camera/pan/zoom | Selection or viewport transform only | No source teardown, DOM detachment or new scope; normal user focus changes keep their existing semantics |
| `applySelectionColor` | Node/edge color only | Update wrapper/edge style without rebuilding owned content |
| `connectSelectedNodes`, `removeEdge`, `editEdgeLabel`, `editEdgeLabelInline`, `beginEdgeReconnect`, `beginConnection` | Edge model/geometry only | Reconcile edge SVG independently; preserve every node wrapper and owned editor |
| `editGroupLabel`, `setGroupBackground`, `removeGroupBackground` | Group decoration changes | Update or replace only the affected non-Markdown presentation, preserving sibling native editors and media lifecycle |
| `editTextNode` entry | Removes a Markdown root to show a textarea | Preflight and prepare the affected scope before replacing content or triggering blur; refuse with connected draft/Retry controls |
| `editTextNode` commit/cancel, newly added text cancel | Source changes or presentation removal | Stage source/model/selection changes and retirement before authoritative mutation; retain the source editor on refusal |
| `openSwapFilePicker` callback | Changes target file/subpath | Capture current node/file identity; stage affected retirement before changing the target |
| `convertTextNodeToFile` | Creates a note and changes text presentation to file presentation | Prepare source presentation before create/model replacement; preserve successful-created path and reachable retry if board save fails |
| `deleteSelection` | Removes nodes and connected edges; edge-only deletion is non-destructive to node presentations | Preflight all affected scopes before selection/model/history/disk changes; prepare all before closing any sibling |
| `load`, `reloadFromFile`, `setFileNative`, `acceptExternalText`, `presentConflict`, `enterRecoveryMode` | Replaces model/context, including invalid input recovery | Validate and stage all old presentations before model, history, file identity or DOM changes; refuse unsupported conflicting state with original controls intact |
| `restoreHistoryNative`, history error rollback, `recoverNativeWrites` history projection | Replaces node objects or restores an old model | Stage before model/selection/undo/disk changes; preserve actual object ownership and connected recovery controls on failure |
| `closeNative`, owner retirement | Disposes all presentations/media | Whole-subtree preflight/drain/prepare before any destructor; await close once and retain failed scope inventory |

Presentation identity includes owner/file context, node object/ID/kind, source text or target/subpath, and decoration inputs that affect owned content. Geometry, selection and layering are separate mutable projection inputs. Existing event handlers capture a node object, so a replacement model object cannot inherit its old presentation without rebinding.

Pending content/media callbacks currently compare against global `renderVersion`. Retained presentations need their own liveness identity so an unchanged pending mount survives a geometry redraw while retired work cannot publish. Object URLs must remain valid for retained media and be revoked when their owning presentation retires. Group/background requests and file-note fallback paths are included.

## Staged destructive operations

Serialize per Canvas owner. Capture file/model identity and affected presentations. Preflight the complete affected set before interaction changes, then freeze admission and settle pending mounts/writes. Prepare the complete set before any destructor. On preparation failure, keep model, selection, history, bytes and connected controls; restore allowed admission and reachable recovery. Close prepared old scopes once, then commit the model/source/render/save operation. A partially failed destructor remains closed with visible failure.

An internal awaitable MarkdownRenderer retirement boundary must retain its weak scope entry until successful close. The compatibility `dispose()` entry may start teardown, but its void return is not successful retirement evidence. Geometry redraw remains synchronous and must not move focused subtrees through a fragment or detach/reinsert retained wrappers.

## Verification plan

Write actual Electron regressions for Canvas text and file-note presentations containing Base controls: an uncommitted draft survives direct geometry redraw with the same connected input and no source write; move/resize preserves node ownership while ordinary user blur remains allowed. Exercise destructive edit/delete/reload/history refusal before model/selection/undo/disk mutation and retained Finish/Cancel/Retry controls. Include the full Markdown → Canvas → Markdown → Base chain and Live Preview direct Canvas path.

Targeted ownership/retirement units cover delayed mounts, multiple siblings, rejected definition/row writes, explicit retry, close once and stale request rejection. Run existing Canvas interaction/gesture/history/conversion suites after implementation, plus full gates and independent review. No runtime parity or completion claim is supported yet.

## Adjacent owning projections to prove before broader clearance

`MarkdownView.renderReadingNative` also calls void disposal and immediately clears its old reading container. `toggleMode` can hide an old owning projection, while `toggleSource` reconfigures CodeMirror and triggers `EmbedWidget.destroy`. CodeMirror can destroy widgets during virtualization independently of a Canvas command; its void destructor cannot await a native draft/save refusal. A retained failed scope alone does not prove the original Retry control remains reachable.

The Electron regression file therefore includes Reading refresh and Live Preview source reconfiguration after a rejected nested row write. These are concrete failure probes; no general recovery handoff design has been implemented. If native controls cannot remain connected before refusal, virtualization needs an owner-bound recoverable presentation handoff rather than a Canvas-only rendering change. That larger boundary must be decided separately after the actual probes run.

## Initial real-app failure classification

At source `eff2920` with locked Electron 42.10.0, the 13 probes produced nine direct ownership failures: text geometry/delete/source/load/undo, and file-note geometry/delete/load/undo. Each entered the actual Base cell editor before the action; redraw disconnected that input, while destructive actions also changed model/selection/history before refusal. Full failure evidence is preserved in the local verification artifacts.

The picker probe is excluded: opening its modal legitimately blurs and saves the cell, consistent with the accepted focus contract. Three nested probes failed before entering the cell editor and provide no ownership evidence. A bounded diagnostic found the table selected without an editor or Canvas source textarea; the nested entry issue remains unresolved. Reading refresh, Live Preview reconfiguration, virtualization and Markdown file-switch ownership remain unverified.

The first correction retains unchanged whole wrappers, their pending render generations and media URLs during geometry/selection/edge redraws. Changed/removed presentations still require the staged retirement correction below; this checkpoint does not establish the whole native boundary.

## Staging checkpoint (awaiting real-app rerun and independent review)

Deletion, text-source entry, full load/recovery, file navigation, file-target swap, conversion and undo/redo now enter the shared Canvas preparation boundary before their authoritative mutation. It captures the file/model/preimage, preflights every affected root before inert/focus changes, prepares the complete set, rejects stale requests, and retires prepared scopes before committing. A pre-destructor refusal restores the original interactive wrappers; a destructor failure latches a persistent error and keeps affected controls disabled. Source-editor completion invalidates only that card's projection. Promotion changes stacking order without re-appending the connected wrapper.

Conflict presentation latches Canvas read-only immediately, but prepares descendants before making their surface inert. If a child draft refuses, its controls stay connected and interactive; Canvas writes remain blocked. A read-only conflict projection uses preparation followed by release rather than native teardown. External replacement still uses the staged load boundary. Actual conflict Finish/Retry behavior requires the scheduled real-app proof.

The focused unit batch has 118 passing tests across eight files with locked dependencies; typecheck and build pass locally. The nine initial real-app failures have not yet been rerun against this checkpoint. The three nested entry failures remain unresolved, and no Reading/Live Preview/virtualization boundary clearance is claimed. Full suites, actual swap-picker coverage, Canvas gesture regression coverage, and independent review remain required. In particular, ordinary mouse gesture lifetime/cancellation must be checked against the native owner barrier before named workspace switching can be enabled.

## Independent review correction batch

Deterministic regressions reproduced three asynchronous ownership gaps in the staging checkpoint. Conflict presentation now carries a generation through preparation, retirement and publication, so an older external load cannot unlock or replace a newer conflict. Destructive preparation also captures selection and checks the complete request again before its first destructor and model commit; deletion uses immutable captured node/edge selections. Selection controls, surface marquee, toolbar actions and delayed callbacks respect the interaction gate.

Mouse drag, resize, duplication, marquee and pan remain registered through pointer up/cancellation. A destructive request refuses an already admitted gesture; existing pointer continuations stop changing state after a conflict blocks interaction. Native owner retirement checks Canvas source drafts and active gestures too.

Undo/redo keeps the old model until the new disk bytes are acknowledged and gates Canvas interaction for the complete write. A rejected write remounts the retained model after preparation invalidated its retired projection; it cannot detach a newly entered user draft during rollback. A newer conflict suppresses stale publication after an already-started successful write, without falsely retaining it as a failed write. Interaction restoration waits for owner admission and preserves a separate workspace pause.

This correction batch passes 126 targeted tests across eight files, typecheck, build and diff checks locally with locked dependencies. Real-app proof, full gates and re-review remain pending. The earlier 118-test result describes the prior checkpoint only.

The touch admission follow-up adds an actual capture-handler regression plus file-card native double-click/context-menu coverage. The final targeted batch is 128 passing tests across the same eight files; typecheck, build and diff checks pass. No real-app rerun has been credited yet.
