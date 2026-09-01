# Page Preview — first-class internal-link hover previews

**Date:** 2026-08-31
**Status:** Approved for implementation

## Problem

Resolved internal links in Reading View and CodeMirror Live Preview navigate, but they do not let a user inspect the destination without leaving the current note. The preview must remain safe and non-editable, follow authored heading targets, and never surface stale async content.

## Constraints

- Reuse Geode's link resolver, Markdown renderer, and tooltip positioning/lifecycle conventions.
- Do not add a dependency, public plugin API, or a second general popover framework.
- Reading View uses plain hover. Live Preview requires Cmd/Ctrl and must not preview source revealed on the active line.
- A preview belongs to one `MarkdownView`; changing file/mode, navigating, Escape, or closing that view tears it down.

## Options considered

| Approach | Advantages | Tradeoffs |
|---|---|---|
| One global delegated app controller | One listener set for every future surface | Ownership and teardown become indirect; source path and active-view state must be rediscovered for every event |
| One controller per Markdown view (chosen) | Lifecycle, source path, mode, and renderer cleanup have one clear owner; Reading and Live Preview still share one implementation | Future sidebar surfaces will need to instantiate or feed the same controller |
| Separate Reading View and CodeMirror implementations | Smallest edits at each call site | Duplicates cancellation, hover retention, positioning, and stale-result protection—the highest-risk behavior |

## Spec

**Approach:** A view-scoped `PagePreviewController` delegates hover events across the Reading View and editor roots, resolves only Markdown destinations, renders a bounded excerpt through a detached `SafePreviewRenderer`, and uses a monotonically increasing request generation to discard stale async work.

**Files affected:**

- `src/renderer/page-preview.ts` — shared controller and pure target/excerpt helpers
- `src/renderer/tooltip.ts` — export the existing viewport-clamped popover positioning primitive
- `src/renderer/views/markdown-view.ts` — own/controller lifecycle and cancellation on file/mode changes
- `src/renderer/markdown/render.ts` and `src/renderer/markdown/live-preview.ts` — intentionally untouched; the controller consumes their existing Reading View and Live Preview markup contracts
- `styles/app.css` — theme-variable preview card styling
- `tests/unit/page-preview.test.ts` and `tests/e2e/page-preview.spec.ts` — rules and real Electron behavior
- `docs/spec/02-core-plugins.md` — record Geode's first delivered surface/setting subset

**Key decisions:**

- Reading View previews on plain hover; Live Preview previews only while Cmd/Ctrl is held.
- Moving from trigger to card and back retains the card. The card is not focusable and does not intercept navigation.
- Only resolved `.md` files qualify. External URLs, unresolved links, embeds, and raw active-line source do not.
- A heading subpath renders only that section. Missing headings fall back to the note excerpt without claiming a false section match.
- Preview content is re-read for each hover, so an external file modification is reflected on the next preview.
- Preview Markdown uses an intentionally detached `SafePreviewRenderer`: it parses into a `template`, removes active/fetch-capable elements and all authored attributes, marks the mounted result inert, and only then inserts it into the document. The canonical `app.markdownRenderer` is deliberately rejected for hover previews because its plugin and code-block processors, embeds (including canvas and Bases), blob/resource URLs, generated click handlers, and raw HTML behavior are designed for an interactive document surface rather than an inert tooltip. The safety boundary deliberately excludes plugin postprocessors, embeds, and callout rendering from this first delivery.
- The detached renderer duplicates a small Markdown parsing path. That creates parser-drift risk as the canonical renderer evolves; preview parity and sanitizer coverage must therefore be reviewed when Markdown syntax support changes. This tradeoff is accepted in exchange for a narrow, auditable inert-content boundary.
- Switching directly between existing split groups emits the established `active-leaf-change` event exactly once when the effective leaf changes, invalidating view-owned transient UI through the existing lifecycle seam.
- The existing app settings surface has no Core Plugins category or per-surface model. Adding that architecture is explicitly out of scope; the documented default modifier behavior is implemented directly.

**Riskiest assumption:** CodeMirror always removes `.cm-live-*link` decorations from the active source line before hover targeting; Electron coverage explicitly verifies this.

**Out of scope:** Sidebar/file-explorer/search/backlinks opt-in surfaces, plugin hover-link API activation, block-reference extraction, and Page Preview settings UI.

**Done when:** Electron tests prove source-relative Markdown links, wikilinks/aliases/headings, missing/external/embed/active-line exclusions, stale cancellation, trigger-to-card retention, Escape and teardown, and external-refresh behavior; unit, Electron, mobile, typecheck, build, parity, and diff gates pass; light/dark screenshots are visually reviewed.
