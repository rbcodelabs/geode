# ADR-0009: Fail-closed ESM preflight for mobile CommonJS plugins

**Date:** 2026-08-29
**Status:** Proposed

## Context

Geode's mobile plugin runtime evaluates an admitted community plugin as CommonJS text with a
browser-only `require` resolver. The resolver can reject an unknown CommonJS specifier, but it never
sees native ESM syntax. A static `import` currently reaches `Function` compilation and fails with an
engine-dependent syntax error. More importantly, a top-level dynamic `import()` can create a native
promise when the wrapper runs; rejecting it after evaluation is too late and can produce an unhandled
rejection or attempt WebKit module resolution.

The problem is to identify every lexically present static import, re-export-from, dynamic import,
source/defer-phase import, and `import.meta` use before compiling or running untrusted plugin text. A
literal module specifier must produce the same bounded, sanitized diagnostic on Chromium and WKWebView.
Non-literal dynamic expressions must also fail closed, even though no exact module name exists at
analysis time.

Hard constraints:

- Mobile continues to execute only CommonJS plugin bundles. The preflight must not transform ESM or
  introduce a second module loader.
- No plugin text may be compiled or evaluated until parser initialization and preflight complete.
- The mobile output is a self-contained browser IIFE built by esbuild; the parser must bundle into it
  and must not fetch a grammar, WASM file, or module at runtime.
- Diagnostics may contain the plugin-authored module specifier, but never source excerpts, resolved
  URLs, native error text, absolute host paths, or secrets.
- Desktop's trusted Node-capable loader and module resolution remain unchanged.

Success means an ESM-bearing fixture is rejected deterministically before any tripwire or native
import promise runs, while an import-free CommonJS plugin proceeds to the existing `require` resolver.

## Decision

**Approve `es-module-lexer` 2.3.1 as an exact-pinned direct runtime dependency for this
architecture.** It is already present only transitively through Vitest; that transitive relationship
is not a runtime contract and must not be relied upon. The implementation should add exactly
`"es-module-lexer": "2.3.1"` under `dependencies`, not a caret range, and record the lockfile change.
Upgrades are deliberate compatibility changes accompanied by the preflight fixture suite.

Use the default browser build, whose small inlined WASM payload is included by esbuild in the existing
self-contained mobile IIFE. Geode already requires dynamic code evaluation to run community CommonJS
plugins, so the lexer's initialization does not broaden the mobile plugin trust boundary. The
implementation must nevertheless prove that a production `build:mobile` has no emitted or requested
sidecar asset. If WKWebView/CSP evidence invalidates that assumption, switch the same pinned package to
its `/js` asm.js export; do not weaken or skip preflight.

Change the mobile evaluator boundary to asynchronous and use this exact order:

1. Admission decides whether the manifest is eligible. A blocked manifest is still rejected before
   reading its entry module.
2. For an eligible plugin, read the complete entry text subject to the existing plugin-size limit.
3. Await one module-scoped lexer initialization promise. Lazy initialization on the first eligible
   plugin is acceptable; optional startup prewarming is only an optimization and may never be relied
   upon for correctness.
4. Parse the complete source and inspect import records in source order. Any record is fatal on mobile,
   including a specifier that would be supported through CommonJS `require`.
5. Reject the first record deterministically:
   - a static, re-export-from, or literal dynamic import uses the lexer's decoded `n` value and the
     shared module-specifier sanitizer;
   - a non-literal dynamic import reports the stable token `dynamic-expression` rather than echoing a
     source expression;
   - `import.meta` reports the stable token `import.meta`;
   - source/defer phase variants retain their lexer-reported kind but otherwise follow the same rule.
6. If imports are absent but lexer exports are present, reject with `ESM_EXPORT_UNSUPPORTED`. Mobile
   accepts CommonJS bundles, not partially supported ESM, and should not expose a WebKit syntax string.
7. Only after preflight succeeds, compile the CommonJS wrapper with `Function`; only after compilation
   succeeds, run it with the existing mediated `require`.

Failures are structured internally and rendered through one stable formatter. At minimum they carry:

- `ESM_IMPORT_UNSUPPORTED` with sanitized plugin id, import kind, and sanitized exact literal
  specifier;
- `ESM_DYNAMIC_EXPRESSION_UNSUPPORTED` for a non-literal dynamic import;
- `ESM_IMPORT_META_UNSUPPORTED` for `import.meta`;
- `ESM_EXPORT_UNSUPPORTED` for export-only ESM; and
- `ESM_PREFLIGHT_FAILED` if lexer initialization or parsing itself fails.

The sanitizer is shared with unsupported `require` diagnostics: accept only the existing conservative
module-id character set, replace every other code point deterministically, and apply a fixed bound.
Do not substitute a resolved path or quote parser/engine exceptions. Initialization or parse failure
is fail-closed and is awaited by enable/startup, so it cannot become an unhandled promise. Plugin
quarantine receives the structured code, not a raw native exception.

This lexer is an admission aid, **not a JavaScript sandbox**. It detects syntactically present ESM
constructs, including ones nested in ordinary functions, while correctly ignoring comments and string
literals. It cannot prove the absence of code-generated ESM such as a string later passed to indirect
`eval`, nor can any of the parser alternatives below. Mobile plugin trust, opt-in, quarantine, scoped
vault APIs, and the absence of Node globals remain necessary controls. Documentation and tests must
not claim stronger isolation.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Promote exact-pinned `es-module-lexer` 2.3.1 to a direct runtime dependency | Purpose-built import records; covers static/dynamic/import-meta and newer phase syntax; approximately 17 KB uncompressed default browser module before bundling; already resolved in the current lockfile; deterministic source offsets and decoded literal names | Adds a runtime dependency and one awaited initialization; default build embeds WASM and must be verified in WKWebView/self-contained output; lexer is intentionally not a full syntax validator or sandbox |
| Use the direct devDependency TypeScript 6 compiler API at runtime | Full AST and familiar TypeScript APIs; could classify exports and other syntax in one pass | Ships a compiler orders of magnitude larger than this need; materially hurts mobile cold start and memory; devDependency/runtime mismatch; still cannot detect imports manufactured as strings; rejects the smallest-viable-architecture constraint |
| Use esbuild's parser/transform at runtime | Parser already used by the repository build; handles modern syntax | esbuild is a Node-side devDependency and its browser/WASM runtime is not in the app; transform output is not a clean admission record; transformation risks turning rejection into execution; much larger initialization and bundle surface |
| Hand-written scanner or regular expression | No dependency; synchronous | Cannot reliably distinguish comments, strings, templates, regex literals, escapes, nested dynamic expressions, import attributes, or emerging import forms; a false negative reaches native import execution, so this is not acceptable for a safety gate |
| Build-time validation during install | No parser cost during startup; can reject before files become active | Plugins may arrive through Files/sync/manual copy and updates can race across devices; install-time evidence is not authoritative for the bytes evaluated later; still requires a runtime integrity/preflight path |

## Consequences

- Plugin enable/evaluation becomes async. Callers must await the entire preflight and evaluation path;
  fire-and-forget evaluation is prohibited.
- Literal ESM imports receive exact, stable module diagnostics without evaluating plugin code. Even
  `import("obsidian")` is rejected because only `require("obsidian")` participates in the supported
  CommonJS resolver.
- First use pays a small one-time lexer initialization cost. Later plugins reuse the same settled
  initialization promise and parse in linear time.
- The production mobile bundle grows modestly, but avoids shipping TypeScript or an esbuild runtime.
- Lexer initialization becomes a plugin-runtime availability dependency. Failure disables mobile
  community plugin evaluation for that session, while vault read/edit/save remains operational.
- The package is a direct production dependency with an intentionally narrow upgrade policy rather
  than an accidental benefit of the test runner's dependency tree.

Required tests include comments/strings containing fake imports, escaped literal specifiers, static
imports, re-export-from, literal and non-literal dynamic imports, nested dynamic imports,
`import.meta`, source/defer-phase forms supported by the pinned lexer, multiple imports proving
source-order diagnostics, initialization/parse failure, and a top-level dynamic-import tripwire proving
that neither native resolution nor an unhandled rejection occurs. A production bundle audit must prove
no runtime parser asset request.

## Risks

- The riskiest assumption is that the default inlined-WASM lexer initializes reliably in the minimum
  supported iOS WKWebView and under Geode's final content-security policy. Native simulator and physical
  device evidence can invalidate the default-export choice; the `/js` export is the approved fallback.
- Future JavaScript import syntax may require a lexer upgrade. Exact pinning trades automatic syntax
  coverage for reproducibility; upgrade fixtures make that trade explicit.
- A plugin can construct code at runtime or call ambient dynamic-evaluation APIs. This ADR prevents
  lexically present ESM from escaping the CommonJS resolver; it does not make same-realm community code
  untrusted or capability-secure. If hostile-plugin isolation becomes a requirement, revise the runtime
  architecture around a separate realm/process and message-based API rather than extending this lexer.
- Sanitizer changes would alter user-visible diagnostics and quarantine keys. Treat the formatter as a
  tested compatibility surface.

This recommendation should be revised if Geode removes same-realm CommonJS evaluation, adopts an
actual browser ESM plugin contract, or requires hostile-code isolation rather than trusted-code
compatibility gating.
