# C1a final-base caller audit and RED preparation

Task c65cbc91-82c3-4256-8789-4f39e915b8e8; parent 5ebcf1f8-5fab-421f-8ab8-1989300588b7; Solution ac76d20b-1183-4698-af07-21e3d0560dfe. Exact reviewed base 0a6a9e199fe07a66f2bea3ed3e7f5efcf629e6b3. ADR0048 coordinator acceptance applies; production held until root accepts combined full gate and explicitly releases implementation.

## Classification of actual callers

| Actual caller at base | C1a policy | Evidence / scope |
|---|---|---|
| Workspace.setActiveLeaf object/default overload at workspace.ts3217–3227 | Explicit focus:false/default is private programmatic hide cause; focus:true ordinary | Actual six baseline tests ported unchanged; repeated/no-focus trusted callback/explicit focus positive added |
| Legacy Workspace.setActiveLeaf boolean/third-focus overload | Resolve existing legacy focus exactly; no signature changes | Needs explicit control before source freeze |
| TabGroup.setActiveLeaf1050; revealActiveLeaf987 | Begin exact outgoing owner before mod-active mutation; only public explicit no-focus route receives cause | Direct group callers retain ordinary behavior; same-leaf/reentrant must not create fresh authority |
| TabGroup collection menu793/802, pointer collection1392, tab1457 and createLeaf951 | Ordinary direct caller; no no-focus cause inferred from absence of focus() | Existing trusted pointer/Tab positives retained; command/menu dispatch has no blanket trust inferred |
| TabGroup pointer/mousedown874 → Workspace.setActiveGroup3053 | Ordinary deliberate route | Must invalidate matching entering receipt before default transfer; hidden old draft gets no synthetic save |
| Workspace.setActiveLeaf → TabGroup.setActiveLeaf → setActiveGroup → syncAdaptivePresentation2791 | Deferred: compact/mobile center-group behavior remains unchanged in first C1a slice | Root accepted desktop-first sequencing; real mobile-host package and breakpoint handler2568/2660/2946 excluded |
| Workspace.enterFocusPane2722/toggleFocusPane and clearFocusClasses | Deferred focus-mode layout hide; no exception | Different class/ancestor visibility from C1a tab mutation |
| Workspace.revealLeaf3525; openViewOfType3499; WorkspaceLeaf.setViewState277 | Existing ordinary activation | No default no-save cause propagated; public focus:false must use its exact API boundary |
| App.openFile canvas4912/Base/md/image4943; openGuestWindowInTab4363; other direct existing-leaf group activation5076/5307/5312/6015 | Existing ordinary activation | Scope excludes changing file-open/background popup activation behavior |
| App guest focus4336, Bookmarks4841, external resource4893, search/outline5696/5918 and onboarding453/459/490 → revealLeaf | Existing ordinary activation | No ambient classification by active DOM element or event.isTrusted |
| Workspace.moveLeaf3596 → extractLeaf1019/insertLeaf1033 → target.setActiveLeaf3611 | Strict readiness before extraction for cross-container native unfinished state; preserve destination selection on refusal | Real Workspace+real Base readiness unit matrix drafted; actual nested Reading/LP move controls drafted |
| Same-group moveLeaf reorder3598 | Keep existing reorder; no scope retirement/hide cause | Actual Workspace unit positive |
| Trusted drag898/922/925/928/1425/1497/1507, Sidebar drag1783/1785 | Same shared strict move guard; deliberate prior blur may save normally | No synthetic flush; actual trusted drag positive remains needed |
| Sidebar.addLeaf1881/setActiveLeaf2112/revealInDock/show/presentMobile/restorePersistentPresentation | Deferred sidebar visibility behavior; cross-container extraction still must be guarded | C1a is not sidebar/drawer parity |
| Layout restore3794/3867/3934/3955/3969; detached builtin relocation3778 | Retirement/restore policy, no background preservation exception | Audit strict guard compatibility; never assume batch restore preserves connected root |

The search inventory is an aid, not proof that dynamic plugin callbacks were enumerated. All unclassified direct group callers remain ordinary. Canvas text/edge editors, sidebar/drawer/collapse, general adaptive breakpoint transitions and persistent LP are later gaps.

## Tests prepared; none newly executed here

Original six actual Reading/LP cases are retained with unchanged provider/input/root/parent/camera assertions and trusted wheel hitmap. Their historical 14d terminal result remains two meaningful RED/four trusted positives. The new combined base requires its own run.

The combined-base spec has **20 actual E2E cases**: six original cases, plus fourteen additions (seven per mode). The additions cover repeated/same-leaf activation, focus:true ordinary save, explicit focus:false within a trusted callback, dirty cross-container move refusal, hidden strict close refusal, explicit cancel after reveal, and nested active-leaf-change activation followed by visible deliberate blur-save. Five separate real Workspace move unit cases use actual Base assertWorkspaceLoadReady and RenderOwnership: draft/conflict/suspended-pending refusals, clean cross-container move and dirty same-group reorder. These do not import an unimplemented helper and cannot fail merely because an implementation module is missing.

Before implementation, additional real-seam tests must cover owner/session/Vault/root/path currentness, nested/reentrant/aborted hide, visible second owner, strict hidden replacement and both A47 overlap orderings. These depend on concrete private binding seams; they are not claimed from the five move controls. Compact real class-target coverage and clean actual cross-container move also remain to prepare. No C1a implementation claim or full coverage claim yet.


## Compact host sequencing constraint

`isCompactMobile()` requires the actual mobile host body class as well as the compact query. Desktop width alone is not sufficient, and manually setting the body class would not prove a production host transition. Existing mobile Table has explicit save/cancel and omits desktop automatic blur-save. A separate real mobile renderer fixture is required to characterize that host-hide route; source scope/sequencing has been raised to root. No compact coverage or no-save source change is claimed here.


## Draft implementation checkpoint

Desktop public Workspace.setActiveLeaf default/object/legacy focus:false activation of another tab in a center TabGroup obtains an exact outgoing source context BEFORE class mutation and finalizes in finally. Direct group calls retain ordinary semantics. Existing source-view onReveal clears exact visibility authority; no focus request is added. Markdown source lifetime captures exact lazy leaf/view/container/parent/file/path/Vault/root/render token/editor/mode/transition/text; standalone Base/Canvas have their own lazy source lifetime. Separate context is explicitly threaded beside navigation through Reading/LP and Canvas note/text descendants, with no close-context or A47 receipt reuse. Canvas text/edge writers do not register and remain uncovered.

Base owns registration cleanup after successful persistence settlement; exact Base/source/table/session/input/cell/value/generation/definition/Vault/root/pending/failure validation grants only blur-save decline before Table commits. Table keeps explicit Enter/Escape, retry-button and original A47 mark/attempt behavior. Strict cross-container move calls the existing renderOwner.assertRetirementReady synchronously before companionOwner/extraction/target selection, reporting refusal without implicit save. This shared safety guard also reaches cross-container callers; it does not confer sidebar/mobile visibility preservation.

Focused local verification is intentionally bounded (98 real-seam tests across3 files, ~1.1s), not the heavy final suite: Base/Table exact session ownership/currentness (including meaningful stale-grid rejection RED), source owner lifecycle, reentrant interval finalization, aborted hide, new sessions, cleanup/deliberate intent, strict move controls, existing50 A47 controls plus2 actual App guard/Base/Table overlap orderings. The overlap tests invoke actual App prepare/release callbacks and Table blur with owned DOM collaborators; they are unit contract evidence, not actual mobile/browser hide coverage. Full types/build/E2E/mobile/hosted are pending root/independent review.
