# C1a desktop caller audit and verification

Task c65cbc91-82c3-4256-8789-4f39e915b8e8; parent 5ebcf1f8-5fab-421f-8ab8-1989300588b7; Solution ac76d20b-1183-4698-af07-21e3d0560dfe. Exact reviewed base 0a6a9e199fe07a66f2bea3ed3e7f5efcf629e6b3. Accepted ADR0048 governs the bounded desktop slice. The combined prerequisite and final C1a Linux/mobile gates are accepted; hosted macOS and broader integration remain separate.

## Classification of actual callers

| Actual caller at base | C1a policy | Evidence / scope |
|---|---|---|
| Workspace.setActiveLeaf object/default overload at workspace.ts3217–3227 | Explicit focus:false/default is private programmatic hide cause; focus:true ordinary | Actual six baseline tests ported unchanged; repeated/no-focus trusted callback/explicit focus positive added |
| Legacy Workspace.setActiveLeaf boolean/third-focus overload | Resolve existing legacy focus exactly; no signature changes | Existing public-contract unit covers legacy focus resolution; no separate native legacy-overload E2E claim |
| TabGroup.setActiveLeaf1050; revealActiveLeaf987 | Begin exact outgoing owner before mod-active mutation; only public explicit no-focus route receives cause | Direct group callers retain ordinary behavior; same-leaf/reentrant must not create fresh authority |
| TabGroup collection menu793/802, pointer collection1392, tab1457 and createLeaf951 | Ordinary direct caller; no no-focus cause inferred from absence of focus() | Existing trusted pointer/Tab positives retained; command/menu dispatch has no blanket trust inferred |
| TabGroup pointer/mousedown874 → Workspace.setActiveGroup3053 | Ordinary deliberate route | Must invalidate matching entering receipt before default transfer; hidden old draft gets no synthetic save |
| Workspace.setActiveLeaf → TabGroup.setActiveLeaf → setActiveGroup → syncAdaptivePresentation2791 | Deferred: compact/mobile center-group behavior remains unchanged in first C1a slice | Root accepted desktop-first sequencing; real mobile-host package and breakpoint handler2568/2660/2946 excluded |
| Workspace.enterFocusPane2722/toggleFocusPane and clearFocusClasses | Deferred focus-mode layout hide; no exception | Different class/ancestor visibility from C1a tab mutation |
| Workspace.revealLeaf3525; openViewOfType3499; WorkspaceLeaf.setViewState277 | Existing ordinary activation | No default no-save cause propagated; public focus:false must use its exact API boundary |
| App.openFile canvas4912/Base/md/image4943; openGuestWindowInTab4363; other direct existing-leaf group activation5076/5307/5312/6015 | Existing ordinary activation | Scope excludes changing file-open/background popup activation behavior |
| App guest focus4336, Bookmarks4841, external resource4893, search/outline5696/5918 and onboarding453/459/490 → revealLeaf | Existing ordinary activation | No ambient classification by active DOM element or event.isTrusted |
| Workspace.moveLeaf3596 → extractLeaf1019/insertLeaf1033 → target.setActiveLeaf3611 | Strict readiness before extraction for cross-container native unfinished state; preserve destination selection on refusal | Real Workspace/Base readiness unit matrix and actual nested Reading/LP refusal controls pass |
| Same-group moveLeaf reorder3598 | Keep existing reorder; no scope retirement/hide cause | Actual Workspace unit positive |
| Trusted drag898/922/925/928/1425/1497/1507, Sidebar drag1783/1785 | Same shared strict move guard; deliberate prior blur may save normally | No synthetic flush; inherited clean drag/move regressions pass, dirty native sidebar relocation is not separately proven |
| Sidebar.addLeaf1881/setActiveLeaf2112/revealInDock/show/presentMobile/restorePersistentPresentation | Deferred sidebar visibility behavior; cross-container extraction still must be guarded | C1a is not sidebar/drawer parity |
| Layout restore3794/3867/3934/3955/3969; detached builtin relocation3778 | Retirement/restore policy, no background preservation exception | Audit strict guard compatibility; never assume batch restore preserves connected root |

The search inventory is an aid, not proof that dynamic plugin callbacks were enumerated. All unclassified direct group callers remain ordinary. Canvas text/edge editors, sidebar/drawer/collapse, general adaptive breakpoint transitions and persistent LP are later gaps.

## Verified acceptance surface

The actual Reading/Live Preview spec has 20 cases: the original six no-save and deliberate pointer/Tab cases plus fourteen additions. These cover repeated/same-leaf activation, explicit focus:true ordinary save, explicit focus:false within a trusted callback, dirty cross-container move refusal, hidden strict close refusal, explicit cancel after reveal, and nested active-leaf-change activation followed by deliberate blur-save. Original provider/input/root/parent/camera assertions and actual trusted wheel/hit-map guards remain intact.

The focused three-file unit surface has 104 cases: 47 private visibility/Base/Table/currentness controls, 52 sync-focus controls (50 prior and two visibility/sync ordering additions), and five real Workspace/Base move controls. Currentness covers exact owner/session/cell/grid/source/file/Vault/root/path/value/lifecycle state, reentrant stale finalizers, aborted intervals, new sessions, registration cleanup, deliberate intent and optional capture during admission holds. Actual Table input mousedown tests retain ordinary-cell, stale-input and unrelated-input behavior. Sync ordering uses actual App prepare/release and Base/Table methods with owned DOM collaborators; it does not establish every platform's browser event ordering.

Dedicated compact/mobile visibility, multiple simultaneously edited visible source owners, hidden replacement and dirty sidebar relocation remain additional acceptance work. The inherited full suite covers ordinary clean cross-container moves and source replacement; those are not evidence for every dirty native variant.

## Compact host sequencing constraint

`isCompactMobile()` requires the actual mobile host body class as well as the compact query. Desktop width alone is not sufficient, and manually setting the body class would not prove a production host transition. Existing mobile Table has explicit save/cancel and omits desktop automatic blur-save. A separate real mobile renderer fixture is required to characterize that host-hide route; the accepted sequencing defers that route. No compact coverage or no-save source change is claimed here.


## Implemented private boundaries

Desktop public Workspace.setActiveLeaf default/object/legacy focus:false activation of another tab in a center TabGroup obtains an exact outgoing source context BEFORE class mutation and finalizes in finally. Direct group calls retain ordinary semantics. Existing source-view onReveal clears exact visibility authority; no focus request is added. Markdown source lifetime captures exact lazy leaf/view/container/parent/file/path/Vault/root/render token/editor/mode/transition/text; standalone Base/Canvas have their own lazy source lifetime. Separate context is explicitly threaded beside navigation through Reading/LP and Canvas note/text descendants, with no close-context or A47 receipt reuse. Canvas text/edge writers do not register and remain uncovered.

Base owns registration cleanup after successful persistence settlement; exact Base/source/table/session/input/cell/value/generation/definition/Vault/root/pending/failure validation grants only blur-save decline before Table commits. Table keeps explicit Enter/Escape, retry-button and original A47 mark/attempt behavior. The shared cross-container move seam calls the existing renderOwner.assertRetirementReady synchronously before companionOwner/extraction/target selection. Actual tests establish refusal for unfinished Base edits without implicit save; Canvas text/edge refusal is not certified here. This shared safety guard also reaches cross-container callers; it does not confer sidebar/mobile visibility preservation.

## Accepted final verification and publication composition

Tested source `cb41b6c9261d684a44be32e87eaf617e9ee20ab2` passed the root/peer-accepted full Linux gate: 267 affected units; 36 focused runtime cases with zero retries; 351 unit files with 5,136 ordinary passes, one expected failure and three inherited skips; full 433-case Electron collection with 418 passes, 15 inherited skips and zero retries. Source-equivalent `21f03f8` mobile exact two and full 76 cases passed without retries or skips. All 558 Linux and 42 mobile artifact hashes, 44 background preserve phases and protected navigation/sync/toolbar witnesses were independently verified. Prior compiler, incomplete Canvas fake DOM, F8 callback fixture and actual input reentry failures remain preserved in the QA archive.

The publication candidate begins at parent PR #395's documentation-only `a9d88cd3afa347fa6ef4db4429657faf902027d2` and applies the exact reviewed common `0a6a9e1` to tested `cb41b6c` delta. All source, tests, dependency and build/configuration files remain byte-identical to `cb41b6c`. The only carried parent delta is four separately reviewed native-combined README/PNG blobs; further changes here are documentation and byte-identical synthetic captures only. These Linux/mobile results do not establish latest-main or whole-feature integration, or a hosted macOS pass.

See [actual C1a captures](../screenshots/native-background-visibility/README.md). Double-clicking the current input still invokes the existing cell startEdit/rebuild path; this pre-existing advisory is outside the single-pointer native focus correction. Compact/mobile host visibility, sidebar/general adaptive behavior, Canvas text/edge writers and persistent Live Preview remain later gaps.
