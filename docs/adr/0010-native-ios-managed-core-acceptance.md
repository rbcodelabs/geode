# ADR-0010: Native iOS managed-core acceptance gate

**Date:** 2026-08-30
**Status:** Accepted

## Context

Geode's mobile Chromium journeys exercise the shared renderer and fake browser host, but they do not prove that the shipped Capacitor application selects the Swift vault adapter, presents the WKWebView accessibility tree correctly, or persists exact bytes through a native process restart. Physical-device QA exposed differences that the browser suite could not observe, including the apparent vault-root shape and touch/safe-area behavior.

The first native acceptance gate must be deterministic, runnable without a developer signing identity, destructive only to an ephemeral simulator, and narrow enough to diagnose whether a failure belongs to the Swift adapter, the renderer, or the UI interaction layer.

## Decision

Add one shared-scheme XCUITest managed-core journey, run on a newly created iPhone simulator. A DEBUG-only fixture and verifier are enabled only when both an exact launch argument and environment variable are present and the process is running in a simulator. The fixture seeds the managed vault; the verifier exposes native adapter identity, vault identity, exact visible root entries and bytes, hidden-trash state, and bounded JavaScript errors to the accessibility test.

The runner captures its simulator UDID, deletes only that simulator on exit, retains screenshots and the `.xcresult` under an ignored repository-local artifact directory, and pins Xcode through `DEVELOPER_DIR`. Browser tests remain regression evidence, not native acceptance.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| XCUITest plus a DEBUG-only native verifier | Proves real touch, WKWebView layout, native adapter selection, exact bytes, and relaunch behavior with actionable failures | Adds a test target and a tightly gated debug seam |
| Native unit tests plus the existing JavaScript smoke probe | Fast and precise for Swift I/O | Does not prove the shipped UI, accessibility tree, or user touch journey |
| Fully black-box XCUITest with no verifier | Closest to a user interaction | Cannot reliably distinguish wrong adapter/root identity from renderer failures or assert exact native bytes and bounded JavaScript errors |

## Consequences

- Native managed-core claims require the XCUITest gate; Chromium results alone are insufficient.
- Debug builds gain a simulator-only reset/verifier path that is unreachable without the exact test launch contract.
- Xcode project and scheme files become reviewed source rather than relying on per-user Xcode metadata.
- External File Provider and real community-plugin network journeys remain separate gates.

## Risks

- Simulator WKWebView touch behavior may still differ from a physical iPhone; device testing remains final corroboration.
- Accessibility identifiers exposed through WKWebView can shift if web semantics regress, so the test uses stable labels and roles and avoids coordinates.
- Xcode project-file changes are sensitive to manual merge errors; `xcodebuild -list` is a required structural check.

## Acceptance

The gate passes only when three consecutive ephemeral-simulator runs prove: native Capacitor host and `managed://default`; `Welcome.md` as a visible root entry with no `Vault` wrapper or visible `.geode-trash`; touch-open and persisted edit; root-sibling New note; exact bytes after termination/relaunch; safe-area-contained Files, Details, editor, and Settings with hittable primary controls; and zero captured JavaScript, unhandled-rejection, or native smoke errors.
