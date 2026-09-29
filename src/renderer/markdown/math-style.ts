/**
 * KaTeX stylesheet, injected the first time math is actually rendered.
 *
 * `__GEODE_KATEX_CSS__` is substituted by esbuild (see esbuild.config.mjs)
 * with KaTeX's own stylesheet after its `woff2` fonts were inlined as `data:`
 * URIs and the `woff`/`ttf` fallbacks dropped. Inlining is what the renderer
 * CSP allows (`font-src 'self' data:`) without shipping a second asset tree to
 * the desktop app and the iOS bundle, which resolve resources from different
 * base directories. Outside an esbuild build (the node unit suite) the
 * constant is undefined and injection is skipped.
 */
declare const __GEODE_KATEX_CSS__: string | undefined;

const STYLE_ID = "geode-katex-styles";

export function ensureMathStyles(): void {
  if (typeof document === "undefined") return;
  if (typeof __GEODE_KATEX_CSS__ === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = __GEODE_KATEX_CSS__;
  document.head.appendChild(style);
}
