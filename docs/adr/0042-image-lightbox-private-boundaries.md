# ADR-0042: Bound lightbox resources, source ownership and focus locally

**Date:** 2026-10-15
**Status:** Accepted by coordinator on 2026-10-15 under the user's reversible tested-PR authority. Design decision only; implementation and parity are not established.
**Related:** ADR-0035 image lightbox P1, ADR-0038 native Markdown lifetime,
ADR-0040 retirement validation and ADR-0034 PDF resource isolation.
**Evidence:** lightbox preflight `bf48624`; accepted static reference/status
`b6f9188`; integrated production at `ef18b43` (source identical to `a84b216`).
No source, tests or runtime behavior is changed by this decision.

## Context

The approved lightbox interactions need concrete private boundaries absent from
current source. Modal provides a shell, scrim dismissal and Escape, but no focus
trap/restoration. Legacy `vault-read-binary` uses lexical path resolution and an
unbounded read. Reading preprocessing changes source lengths; LP widget equality
omits occurrence identity; table cell normalization changes offsets. Existing
metadata traversal stops at an outer Link, hiding a nested Image. None of these
existing paths establishes the proposed lightbox contract by reuse alone.

The actual PDF reader/IPC pattern establishes canonical current-session access,
bounded handle reads, original file identity checks and scoped cancellation.
Its API remains PDF-specific. The image feature should copy the narrow pattern
with its own types/limits, without broadening that API or changing legacy media.
The five approved light/dark/compact/error/LP-selection static captures were read
for this review; they are visual intent, not application evidence.

The goal is a read-only owned-note gallery with exact occurrence identity,
recoverable errors, predictable focus and settled cleanup. Dirty main Markdown
must remain inspectable; opening a modal must not blur/save an unfinished embedded
native draft. No new dependency, network/CSP permission, public plugin interface,
PDF embed, global Modal rewrite or persistent native overlay is included.

## Options considered

| Option | Benefit | Cost / limitation |
|---|---|---|
| Private source projection, bounded host capability and local Modal/coordinator (recommended) | Meets the concrete authority, ownership and keyboard contract with a narrow change | New private modules and exact renderer/LP mapping seams require proof |
| Harden legacy binary reader and global Modal for every consumer | Broad consistency | Changes media/plugin/dialog behavior beyond this feature; materially larger regression surface |
| Discover DOM images and reuse widget URLs or open ImageView tabs | Small initial implementation | Wrong duplicate/transclusion association, stale URLs and different interaction behavior; does not meet the approved gallery contract |

## Decision

Recommend the first option, with foundation modules first and shared hooks only
on a frozen coordinator-cleared integration base. The following limits are
reversible P1 product choices, not claims of complete image parity.

### Complete source and occurrence contract

Project at most **300,000 UTF-16 code units of the complete current LF editor
snapshot**. Check before parsing. A larger snapshot is explicitly unsupported;
do not parse a prefix or inherit an unlimited per-vault metadata setting. At the
ceiling, the complete snapshot and gallery order must remain accurate. This
bounds input size, not parser execution time. Characterize malformed delimiter,
nesting and whitespace cases; a synchronous grammar parse cannot honestly claim
mid-parse cancellation. If the ceiling still permits unacceptable blocking,
return for a lower explicit limit or parser execution decision before broad hooks.

Create a separate internal image-occurrence projection over that exact snapshot,
sharing installed grammar/reference normalization and existing same-length
exclusions. Preserve existing metadata extraction outputs. Traverse Images inside
Links without changing markdownReferences' outer-link semantics. Keep wiki,
Markdown direct/reference and linked context, original ranges, authored target,
label/title and owner snapshot. Exclude code/comments/frontmatter/raw HTML and
transcluded-note content. Resolve only same-vault image targets through current
indexed resolution. Retain supported missing-image occurrences as errors at their
original source positions. Reject authored schemes/absolute/external-root inputs;
unsupported syntax is explicitly partial, never guessed into another occurrence.

Duplicate destinations at different source spans remain separate. Gallery order
is source order across supported occurrences, with bounded previous/next and no
wraparound. Keys bind snapshot identity, source range, authored destination and
current indexed target; a fresh snapshot is not the same gallery revision merely
because its visible image URLs match. CRLF restoration is a write concern: never
serialize or edit source to obtain coordinates or gallery identity.

Before any length-changing Reading preprocessing, substitute exact eligible image
spans with per-render opaque markers from a private map. A marker must survive
inline transforms without interpreting alt/title as HTML. Build safe image DOM or
escaped generated markup from the private entry after transforms. Do not replace
an enclosing link; preserve normal enclosing-link and modified-click behavior.
Bind only a uniquely minted marker to its exact occurrence via private node maps,
then remove token attributes. Reject duplicate/forged/unknown markers. An optional
owned context applies only to the actual MarkdownView render; plugin output,
raw HTML and recursive transclusions inherit no lightbox authority. Markers never
enter the editor buffer or note bytes. Do not associate nodes by DOM order, src,
alt text, filename, normalized fragment search or list position.

LP widgets bind explicit source/snapshot handles. Equality/reuse must rebind the
current exact occurrence or recreate the read-only widget; identical targets do
not preserve stale authority. Selection lives in read-only editor state with no
change/history transaction. Only the focused selected registered image consumes
unmodified Space; text fields, source mode, other panes and ordinary cursor Space
remain unchanged. Long-lived listeners check current owner/admission, rather than
capturing one RenderToken permanently invalidated by an earlier hold/resume.

Table hooks require a source-span sidecar derived from original row/cell syntax,
including trim, escaped pipes and duplicate cell contents. Do not change existing
TableWidget raw equality/focus reuse or infer offsets from normalized cell text.
Pass an explicit owned fragment map to internal inline rendering; intercept only
registered image/zoom actions before cell editing. Direct/reference/linked/table
syntax may be implemented in separate steps. If exact correspondence cannot be
proven, leave that presentation unsupported and document the resulting partial
coverage; do not silently advertise complete P1 syntax coverage.

### Private desktop image-read capability

Add optional internal HostServices imageResources read/cancel methods and exact
preload/main channels, without exporting a public plugin/SDK API. The capability
accepts captured root, relative path and a fresh random 64-hex request ID; cancel
accepts only root/ID. Validate exact keys, nonempty bounded strings (root/path at
most 4096 units), current sender main frame and actual application-window session.
Reject subframes, unknown windows, destroyed senders, changed main-frame identity,
changed session/root and invalidated root authority. Browser/mobile hosts omit the
capability and expose an explicit unsupported inspection state, with no legacy
reader/network fallback. Ordinary image rendering is unchanged.

Main is authoritative. Permit raster extensions PNG, JPEG/JPG, GIF, WebP, BMP and
AVIF only; SVG is unsupported in P1. Validate a supported raster header/family and
use its fixed image MIME, rejecting mismatches and unrecognized bytes. Do not hand
arbitrary markup to a generic decoder by filename alone. No authored URL, absolute,
empty/dot/dot-dot/backslash/NUL segment or virtual external-root path is accepted.

Use a dedicated image reader following actual readAuthorizedPdf's filesystem
pattern: capture session/root; realpath root and target; prove canonical containment;
open the resolved regular file with O_NOFOLLOW where supported; compare handle/path
identity; recheck canonical root/path, inode/device and captured session after awaits;
read chunks no larger than 64 KiB and at most observed size plus one; reject empty,
changed, truncated, growing or oversized data; close the handle in finally. The
main limit is **32 MiB**, checked before allocation and against actual returned
bytes. Renderer file.size is advisory only. Do not modify PDF or legacy binary
semantics to obtain this behavior, or claim atomicity against all hostile host
filesystem races beyond the actual handle/path checks.

Allow **one active image read per application window**, across sessions/IDs, with
no main-side queue or completed-ID history. Retain its entry until the real read
settles, even after cancel or session invalidation. Cancel validates the exact
sender frame, current/captured session identity, root and active ID; it cannot
cancel a foreign/stale request or abort an OS syscall. Check cancellation/current
session after every awaited filesystem step/chunk and before returning bytes.
Busy admission is explicit. PDF's separate document/read budgets remain unchanged.

### App coordinator and owned sessions

Use a private module WeakMap<App, ImageInspectionCoordinator>, analogous to
pdfDocumentCapacity, instead of another public App field. It owns one current
modal/session and one latest pending open/navigation intent, replacing obsolete
intent rather than growing a queue. Register its per-view read-only child scope
synchronously before any load await. It has no write failure key and creates no
standalone unknown writer root. Every intent captures owner/file/Vault/root,
current complete snapshot, occurrence and invoking control; revalidate after
settlement before opening the next intent. Stale intent cannot acquire a new read.

One current image is read/decoded at a time; no eager gallery decode. A session
owns its blob URL/img/listeners/pointer captures/observers, never borrowing a widget
URL. Decode only with an img and explicit supported raster MIME. Reject natural
pixel count above **64 million**. This post-decode check, animated formats and the
32 MiB cap do not bound all browser decoder memory/CPU or prove decoded-image GC.

Navigation/close/invalidation first marks the generation obsolete, hides the old
presentation promptly, clears image source/captures/listeners and requests scoped
main cancellation, then awaits actual read/decode settlement before admitting the
next image. Revoke every owned URL once, including late-created URLs. A timeout
may surface an error but cannot pretend a native operation settled or release
its occupied admission slot. Prove real img cancellation/settlement behavior; if
it cannot meet the close contract, return for an isolation decision rather than
release a hidden decoder and call it canceled. There is no iframe/frame bridge in
this raster-only P1; main-frame IPC authority is still mandatory.

Expose only internal coordinator open, close-for-exact-owner and closeAll seams.
App.dispose and disposeVaultSession must call/await closeAll before Vault.close;
for session replacement close it before workspace leaf disposal, so new intents
cannot race closing leaves. closeAll synchronously gates admission and invalidates
pending intents before awaiting settlement; rejection blocks retirement and remains
visible. A later new vault may acquire a fresh coordinator epoch only after prior
cleanup settles. Do not reset a closing coordinator early or suppress failure.
This is a small explicit App integration change requiring the same single shared
file owner, despite the preflight note's earlier general App exclusion.

Markdown's common explicit replacement boundary closes its exact owner's lightbox
only after complete initial native preflight succeeds and before preparing old
projection children. Ordinary view close and owner pause/root cleanup likewise
signal cancellation before waiting on owned work. Document all affected callbacks.
Never close/drain the Markdown root from its root-tracked transition or wait for
a session's own tracked close from its load task. Child-only teardown may await
its load; the load itself must finish without waiting for that teardown. Scope
freeze/token checks remain the backstop for late work, including direct retirement
paths; actual syscall settlement can delay cleanup and cannot be declared aborted.
No new Scope callback or generic failure acknowledgment is proposed.

### Focus and native draft policy

Before first LP selection that moves focus, Reading/modal entry or replacing one
open modal with another, check current owner/admission/effective inert ancestors,
snapshot and the actual complete affected LP/Reading native projection readiness.
Use synchronous side-effect-free child preflight before pointer default focus.
Dirty outer Markdown alone is allowed: do not flush it, call an own-note receipt
close guard, or mutate/retire children merely to inspect an image. Embedded Base/
Canvas drafts, unresolved writes and native readiness refusal retain their controls
and prevent incidental blur-save. If descendants are paused, do not reopen their
admission. Recheck immediately before delayed modal focus publication.

Reuse Modal's shell with a lightbox-local controller/subclass that implements its
own dialog label, close control, Tab/Shift+Tab trap and focus guards. Do not assume
Modal supplies these. Guard Escape/keys only while this modal is topmost; do not
close another dialog or consume keys in editable fields. Initial focus goes to
Close or the dialog's designated control. Existing linked-image navigation stays
normal; its explicit zoom action is the separate lightbox entry.

On close restore only a still-connected invoking control under the same surviving
current owner and active leaf, with admission and inert checks. If invalid, use the
surviving original editor or safe workspace focus only when that same owner still
owns the interaction. A new modal, another leaf/header, a held owner or root/session
cleanup suppresses restoration. Close caused by source/mode/owner invalidation
must not re-focus the stale control. No global focus trap or body inert override.

## Phased engineering and acceptance

1. **Private foundations:** candidate projection, source ceiling, transforms,
   session/coordinator, bounded reader/IPC, optional host adapter and local Modal
   tests. Copy no shared render/App hooks yet; retain current static visual brief.
   Characterize parser cost and decoder cancellation, with cancellation/read caps.
2. **Sequential shared hooks:** coordinator-cleared frozen integration base and one
   owner for App cleanup, Markdown replacement/pause/close, Reading marker mapping,
   LP occurrence selection/widgets and styles. Tables/reference/linked mapping get
   separate exact-correspondence cases; unsupported paths remain visibly partial.
3. **Actual proof:** Reading/LP focused keyboard and pointer interactions, local
   trap/focus restoration, dirty outer buffers/undo/CRLF bytes unchanged, unfinished
   native draft refusal before focus, held/resumed owners and close/root races.
   Exercise missing/corrupt/over-limit/unsupported/busy states with navigation/Close
   usable. Match approved light/dark/compact/error/selection captures and publish
   evidence through the configured provider; local images alone do not complete it.
4. Independent source/security review and serialized full gates on the same frozen
   integrated tree. Do not change source or tests in the worktree under a frozen
   gate. Independently authorized isolated branches may proceed against pinned
   commits; their changes need separate review and fresh gates before integration.

Regression requirements include header/type mismatch and disguised SVG rejection;
traversal/symlink escape/replacement/growth/size/session/frame/cancel-ID/busy cases;
actual settlement before admission; repeated close/revoke once; no stale UI after
latest intent changes; duplicate destinations and repeated table cells; forged
marker/changed-source/widget-reuse rejection; unchanged metadata outputs; no
transclusion/plugin authority inheritance; Space and normal table/link behavior;
no writes to source or image hashes; source limits without truncation; and effective
hold/root cleanup with reachable native recovery. SVG, external-root/remote images,
Canvas gallery/source resizing and uncertain grammar remain explicitly partial.

## Consequences and risks

The new narrow capability avoids relying on weak legacy authority and confines
keyboard changes to the lightbox. The cost is exact mapping and additional private
cleanup hooks. A single latest intent bounds backlog but can show Busy while a
canceled native read/decode settles. Neither a timeout nor URL revocation proves
all decoder memory released.

The riskiest assumption is preserving exact occurrence/focus ownership through
Reading transforms, LP widget reuse and table normalization. Tests must falsify
wrong association before implementation broadens supported syntax. Real native
image cancellation is another explicit proof gate. If either fails, reduce the
supported presentation set honestly or revisit the narrow execution boundary;
do not fall back to DOM guessing, an unbounded reader or detached recovery.
