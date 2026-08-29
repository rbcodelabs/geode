# Spec: Geode Mobile MVP — Slice 2A Touch Power Views

**Status:** Approved implementation spec under the user-approved mobile program and
[ADR-0007](../adr/0007-mobile-runtime-and-platform-boundary.md).

**Outcome:** Graph, Canvas, and Bases are real mobile workflows, not desktop views that merely fit
on a smaller screen. A user can inspect and modify representative fixtures using touch, persist the
result, rotate or background the app, and reopen the same model without requiring hover, right-click,
or a hardware keyboard.

## Shared interaction rules

- Use Pointer Events and shared view/model implementations. Do not fork separate mobile data models.
- One-finger gestures manipulate the selected object or scroll the nearest scrollable surface;
  two-finger gestures pan/zoom spatial views. The browser page itself must not zoom or scroll during
  a captured graph/canvas gesture.
- Every desktop-only hover/context-menu action required for the fixture journey gets a visible or
  long-press action-menu equivalent with an accessible name.
- Primary targets are at least 44 by 44 CSS pixels. Controls respect safe areas, the visual viewport,
  software keyboard, reduced motion, and iPad pointer/hardware keyboard coexistence.
- Gesture cancellation (`pointercancel`, second pointer arriving, app background, modal opening,
  view disposal) leaves a valid model and releases pointer capture.
- Presentation state may adapt by compact/regular width, but persisted Graph/Canvas/Base source data
  is identical across desktop and mobile.

## Graph

- Single tap selects a node; a second tap or explicit Open action navigates to its note.
- One-finger drag pans empty space; pinch zooms around the gesture centroid within tested min/max
  bounds. Node taps must not accidentally pan or open during a pinch.
- Search, filters, groups, local/global mode, relayout, and reset/fit controls remain reachable in a
  compact sheet/toolbar and preserve current selection where the underlying node still exists.
- A representative large fixture reports partial-index state honestly and remains interactive while
  indexing is incomplete.

## Canvas

- Tap selects; one-finger drag moves a selected node; two-finger drag/pinch pans/zooms the viewport.
- A discoverable action surface supports create text/file/media/web cards, edit text, duplicate,
  delete, connect nodes, change color, and undo/redo. Marquee selection gets a touch alternative.
- Handles and edges use touch-sized hit regions without changing serialized coordinates. Editing a
  text card uses the software keyboard without covering the caret/action surface.
- File/media cards load through scoped vault resources. Closing or replacing media releases old
  object/native URLs.
- Save acknowledgement follows the same writer suspension/conflict rules as Slice 5B1; background,
  external reconcile, and view close cannot race a gesture into stale persistence.

## Bases

- Table and Cards layouts are usable on phone and tablet. Horizontal table movement and vertical
  page/table scrolling arbitrate intentionally rather than both moving.
- Tap selects a cell/card; a visible action enters edit mode. Filter, sort, property selection,
  layout switch, and row/card actions fit within the visual viewport and remain keyboard accessible.
- Software keyboard appearance keeps the active field and commit/cancel actions visible.
- Editing a supported cell updates the authoritative note/frontmatter and refreshes the Base only
  after acknowledged persistence. External reconciliation follows the shared dirty/conflict policy.
- Large result sets remain bounded/virtualized according to the current implementation; this slice
  must not introduce an unbounded mobile-only render.

## Test-first coverage

### Unit/model

- Pointer state machines: tap-versus-drag threshold, two-pointer transitions, centroid zoom, bounds,
  cancellation, capture release, and mouse/pen regression.
- Graph selection/navigation/filter state; Canvas model coordinates/edges/undo; Base edit-to-source
  mapping and scroll arbitration.
- Gesture completion and cancellation persist at most one semantic model update and never a partial
  invalid document.

### Real mobile Chromium

- iPhone and iPad journeys for each view using touch-capable pointer input, asserting model/file
  state after every material operation and again after reload.
- Rotation/width changes mid-gesture and after save; software keyboard for Canvas text and Base cell;
  compact action menus; 44px target geometry; accessible names/focus restoration.
- Graph node open, pan/pinch/filter; Canvas select/drag/pan/pinch/connect/edit/undo/reopen; Base
  scroll/select/edit/filter/sort/layout/reopen.
- Inject `pointercancel`, background, persistence failure, and external reconciliation during a dirty
  model. Assert exact provider/local bytes and recoverable state.
- Desktop mouse/keyboard behavior remains covered by existing Electron tests; mobile changes may not
  convert mouse paths into touch-only paths.

### Native evidence

- Run the shared mobile journeys in the WKWebView simulator where Playwright cannot reproduce visual
  viewport/keyboard behavior, with DEBUG state probes for serialized Canvas/Base data.
- Physical-device multi-touch, selection handles, VoiceOver order, and performance remain release
  gates; simulator/browser evidence is not labelled as physical touch proof.

## Failure invariants

1. A cancelled gesture never leaves a half-mutated Graph/Canvas/Base model.
2. A gesture or edit is not reported saved until its authoritative file write is acknowledged.
3. Touch adaptation does not change desktop file formats or destroy dormant workspace/view state.
4. No required action is hover-only, right-click-only, or below the primary touch target floor.
5. External reconciliation cannot overwrite a dirty Canvas/Base edit or resume its writer before the
   conflict decision settles.

## Done when

- Representative Graph, Canvas, and Base fixtures can be manipulated by touch, saved, backgrounded,
  rotated, force-reloaded, and reopened on iPhone and iPad profiles with exact model/file assertions.
- Accessibility names, focus behavior, touch-target geometry, keyboard avoidance, cancellation, and
  failure/recovery cases are automated where the harness can prove them and explicitly recorded where
  device evidence remains required.
- Typecheck, unit/integration, mobile Chromium, native simulator journeys, full build, parity, and
  Electron regression gates pass with no new data-loss or input-regression finding.

## Explicit later gates

- Performance budgets and representative 1k/8k/20k vault measurements.
- Physical-device multi-touch/VoiceOver/hardware-keyboard matrix.
- Attachment import/share sheet and native scoped resource URL service if not already proven by the
  selected fixture types.
