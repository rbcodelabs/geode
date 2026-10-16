# ADR-0035: Open owned local image occurrences in a shared lightbox

**Date:** 2026-10-15
**Status:** Accepted by coordinator under the user's reversible tested-PR authority. Existing static lightbox reference archived at `Artifacts/threads-design/lightbox-reference-2026-10-15-0150-snapshot` was inspected before engineering. Shared-file wiring still requires an agreed frozen integration base; this decision is not an implementation or parity claim.

## Context

Pinned Obsidian release notes 1.13.2–1.13.4 document a lightbox opened by a
Reading image click or selected Live Preview image click/Space, navigation across
images in the current file, zoom action, drag-to-pan and filename. They separately
document Live Preview source resizing, reset, Enter/Tab editing and Vim commands.
Current main b939adf has a read-only ImageView and plain wiki/Markdown image
widgets, with no shared selection/lightbox model. P1 should make everyday local
image inspection useful without adding note writes, dependencies or network access.

Workspaces is correcting native render ownership and PDF P1 is changing embed
surfaces. Neither is a completed runtime contract to assume from a branch title.
The first package must use a frozen, reviewed integration base and leave source
resizing, remote images, indirect transcluded-image navigation and Canvas gallery
behavior explicitly partial.

## Options considered

| Option | Benefits | Costs |
|---|---|---|
| One owned image-session/controller and existing Modal (selected recommendation) | Common keyboard/lifecycle behavior across Reading and Live Preview; read-only | Explicit occurrence identity and view adapters required |
| Enlarge ImageView in a new tab | Reuses binary image loading | Changes navigation, lacks the current-note gallery and modal focus semantics |
| Discover every img element and reuse its src | Small initial patch | Includes plugin/remote/transcluded content, stale blob URLs and viewport-only ordering; rejected |

## Decision

### Candidate and presentation ownership

Use an internal per-MarkdownView lightbox controller. Its session captures App,
vault object/root, file identity, source snapshot/revision and native render-owner
generation. Derive candidates from the current owned source buffer using the
reviewed shared metadata/reference parser, not a cached disk index or a DOM scan.
Reuse existing wiki/Markdown destination resolution. Exclude code/comments,
frontmatter, non-image embeds, raw HTML and unresolved or unauthorized destinations.
Preserve parser limitations honestly; do not add a second permissive image regex.

Each supported image occurrence has its own stable-in-snapshot key: source range,
authored destination and resolved file identity. Duplicate references to the same
file remain distinct occurrences. Order is ascending source position, including
supported Markdown reference images and images in tables. Navigation stops at the
first/last occurrence; buttons disable at bounds. No wraparound, deduplication or
implicit traversal into transcluded notes. Missing files remain an error at their
original occurrence rather than silently changing gallery numbering.

Reading and Live Preview register presentation handles carrying the exact source
occurrence and captured generation. The renderer must associate handles while
rendering supported source images, without attaching actions to arbitrary plugin
images or guessing from blob URLs. Source offsets must use the same coordinate
system as the captured editor buffer; CRLF serialization must not shift identity.
If a presentation cannot be mapped unambiguously, omit its lightbox action and
retain ordinary rendering/navigation. Candidate extraction and presentation
mapping need one shared contract and synthetic duplicate/table/reference tests.

### Opening and selection

In Reading, plain primary click on an owned image opens that occurrence. Preserve
existing enclosing-link and modified-click navigation semantics: an image inside
a link follows that link; its explicit, labeled zoom button opens the lightbox.
The button is also the keyboard-accessible Reading entry point.

In Live Preview, the first primary click selects a rendered owned image without
changing source or revealing its syntax. Selection is explicit editor state,
bound to one occurrence and revision, rather than a CSS-only class. A second
click, the zoom button, or unmodified Space while that image owns focus opens it.
The selected presentation has a visible focus/selection indicator and accessible
name. Outside click, selection movement away, document edit, mode/file change and
widget destruction clear selection. Do not intercept Space in a text input,
another pane, source editing or an unrelated editor cursor. Existing typing,
selection, shortcuts and table editing keep their current behavior.

### Modal interactions

Reuse Modal focus trapping and shell conventions; expose a labeled close button,
filename, occurrence count, previous/next, zoom in/out and fit/reset controls.
Initial and reset scale fit the available viewport without upscaling a smaller
image. Bound zoom to 0.1–8 times native scale; clamp to a usable fit scale at
extreme dimensions. Zoom preserves the point under the pointer or viewport center;
drag pans only when content exceeds the viewport, with translation clamped to its
edges. Resizing recomputes bounds. Navigation resets fit/pan for the next image.

Inside the modal, Left/Right navigate, +/- zoom, 0 resets fit and Escape closes.
Do not consume arrows or text keys inside an editable field. Buttons provide the
same operations without pointer gestures. Do not use LP +/- outside the modal as
zoom: documented source resizing is a separate package.

Close restores the invoking connected control only if its captured owner/file
still matches; otherwise focus the surviving original editor or safe workspace
control. Never refocus a replaced view or steal focus after vault disposal.

### Binary, security and failure boundaries

P1 accepts only image files resolved and authorized by the current vault's
existing binary-file boundary. It accepts no user-provided absolute path or
network URL. HTTP(S), data, file, javascript and authored blob URLs are not modal
inputs. Blob URLs are created internally from authorized bytes and owned by the
session. External project-root images stay unsupported in this package. Do not
expand existing host permissions or claim that a new modal fixes all pre-existing
image-reader path semantics.

Reuse the supported image MIME mapping. SVG is rendered only as an img backed by
an internal blob, never inserted as markup, object, iframe or executable document.
Keep existing CSP and block external resource expansion. Tests must demonstrate
that SVG script/foreign resource payloads have no execution/network side effects.
If an SVG cannot meet that contract, show an explicit unsupported error.

Read/decode only the current image, with at most one in-flight load. Initial
reversible limits are 32 MiB input bytes and 64 million decoded natural pixels;
report oversize explicitly. Check available file size before reading and actual
byte count afterwards. Natural-dimension checks occur after browser decoding and
are not a claim of complete protection from decoder memory exhaustion. Bound
display transforms and avoid decoding the whole gallery eagerly.

Every load/decode continuation verifies session/generation, vault/file identity
and source revision. Navigation, close, edit, file/mode/vault change and deletion
invalidate obsolete work; late-created URLs are revoked. Native reads may not be
abortable, so cancellation means no late publication plus tracked settlement.
Missing, corrupt, denied and oversized images show filename-specific errors with
Close and navigation still usable. Errors cannot select another file or write a
placeholder into the note. Close/edit invalidation releases pointer captures,
observers, listeners and every owned URL exactly once.

The controller uses the reviewed ADR0032 native RenderScope as a read-only child
of its Markdown owner. Register loads before their first await and teardown before
owner retirement; synchronous widget destruction initiates tracked close. Do not
introduce unknown standalone writer roots. The modal session owns its own image
bytes/URLs rather than borrowing widget URLs that can be revoked independently.

## Consequences and integration order

There is one read-only interaction model and no new public API. P1 does not change
note/image bytes, authored sizes, undo history, links or tab history. Full image
parity remains partial until source resizing/reset/Enter/Tab, Vim, external images
and remaining rendering details have separate evidence.

First freeze and review Workspaces ownership corrections. Then coordinate a
single integration owner for PDF embed wiring and this feature: shared files are
`markdown/render.ts`, `markdown/live-preview.ts`, `markdown/embed.ts`,
`views/markdown-view.ts` and `styles/app.css`; optional ImageView integration is
not required for P1. The new controller/candidate reducer/tests can be isolated,
but shared-file edits must be sequential on an agreed frozen base. Do not stack
against uncommitted PDF/Workspaces changes. Root acceptance and the visual
prototype precede source implementation.

## Risks and acceptance

The riskiest assumption is correct source-occurrence mapping while widgets are
virtualized, comments transform Reading output, and duplicate/reference/table
images render. If that cannot be proved, reduce the supported syntax explicitly
rather than use a DOM-wide fallback. Missing support remains partial.

- Synthetic mixed wiki/Markdown/reference/table gallery: correct source order,
  repeated file occurrences, bounds, filename, no code/comment/frontmatter images.
- Reading click/link/modified-click semantics; LP first selection, second click,
  focused Space, outside deselection, ordinary typing and source mode unaffected.
- Keyboard-only open/navigation/zoom/reset/close, visible focus, focus restoration,
  accessible names and visual checks at compact/large windows and light/dark themes.
- Delayed read/decode then navigation/close/edit/vault switch/widget disposal:
  no stale image, leaked URL, listener or pointer capture; owner drain waits.
- Missing/deleted/denied/corrupt/oversized resources remain explicit and navigable;
  unsafe schemes and SVG active content cannot execute or cause network access.
- Hash image files and compare the complete unsaved source/undo history before
  and after interactions, including CRLF notes; all bytes and history are unchanged.
- Regression units before implementation, real Electron primary/failure flows,
  screenshots, independent review and normal repository gates before a tested PR.

Evidence: current main b939adf source; pinned help
08ef563f07b78dd589f19b1583d089c1e2d2377c, release notes 1.13.2–1.13.4.
Compass task/solution inventory and open PR changed-file lists were checked on
2026-10-15; no image-lightbox owner was found. Recheck before dispatch and publish.
No UI or tests were executed for this design recommendation.
