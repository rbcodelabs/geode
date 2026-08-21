# ADR 0004: Isolate generated design artifacts behind a dedicated origin

Status: Accepted for the static Artifact MVP

## Context

Claude Threads will create small HTML/CSS/JavaScript artifacts that Geode can
preview beside a conversation. Their source is agent-generated and therefore
untrusted. Geode's existing Web Viewer is deliberately browser-like: it uses a
persistent session, supports ordinary navigation, and imports browser cookies.
Those properties are useful for browsing but are the wrong security boundary
for executable local artifacts.

The artifact lifecycle also needs a stable contract shared with Claude Threads,
workspace restoration, live refresh, diagnostics, and screenshots. Coupling
those concerns directly to the Web Viewer or Electron entrypoint would make the
security policy difficult to test and would turn compatibility code into a
Geode-specific product subsystem.

## Decision

Geode will implement artifacts as a separate `geode-artifact` view and origin.

- A versioned, strict manifest is the boundary between producers and Geode.
  Schema v1 supports only zero-install static artifacts and rejects unknown
  fields/capabilities.
- The Electron main process owns artifact registration, real-path containment,
  protocol serving, session policy, permission denial, and navigation denial.
- A dedicated `geode-artifact://<artifact-id>/...` protocol serves contained
  local files. No artifact is loaded with `file://`.
- Each open artifact uses an ephemeral, artifact-specific session partition.
  It does not inherit Geode, plugin, or `persist:webviewer` preload/session
  state. Node integration, popups, downloads, permissions, external navigation,
  and network requests are denied by default.
- The renderer owns only view state and presentation. It requests operations
  through a narrow typed preload API and cannot relax main-process policy.
- Manifest validation, URL policy, and path resolution remain small modules
  independent of `main.ts`, `app.ts`, and `WebView`.
- Content Security Policy is defense in depth, not the sole network boundary.
  The session request filter is authoritative.

The v1 manifest requires `permissions.network: "none"` and
`permissions.clipboard: false`. Future capabilities require a new compatible
schema or an explicitly reviewed extension; they are never inferred from source
files.

## Rejected alternatives

### Reuse the existing Web Viewer

Rejected because its persistent cookie-bearing session, general navigation,
and browser-oriented behavior conflict with artifact isolation. Sharing its
view also entangles Obsidian compatibility with a Geode-native capability.

### Load artifact files directly with `file://`

Rejected because file origins have awkward containment and privilege semantics,
make CSP/navigation policy harder to reason about, and do not provide a clean
per-artifact origin.

### Run an HTTP development server for every artifact

Rejected for the static MVP. It adds process, port, dependency, and teardown
risks without benefit for dependency-free artifacts. A supervised dev-server
runtime may be added later behind a separate capability contract.

### Enforce safety through agent instructions

Rejected as a security boundary. Skills may guide generation, but generated
code is always treated as untrusted and host policy remains authoritative.

## Consequences

- Artifact rendering requires new main/preload/renderer seams rather than a
  small Web Viewer flag.
- Static artifacts cannot use remote fonts, analytics, APIs, forms, or external
  frames in the MVP.
- Strict failure produces more visible manifest errors, but prevents silent
  privilege expansion and makes version migration deterministic.
- The next implementation PR can build the view and protocol against tested
  contracts without growing existing entrypoint god files.
