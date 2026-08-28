/**
 * Lazy loader for the Mermaid bundle.
 *
 * Mermaid pulls in d3, dagre, and cytoscape — several megabytes that must not
 * land in the cold-start renderer bundle. `esbuild.config.mjs` builds
 * `src/renderer/vendor/mermaid-entry.ts` as a *second* IIFE entry point
 * (`dist/mermaid.js`) that assigns the library to `globalThis.mermaid`; this
 * module injects that script the first time a diagram is actually rendered.
 * esbuild code-splitting is unavailable here because the renderer is built as
 * a single-outfile IIFE, so a second entry point is the mechanism.
 *
 * The script loads over `file://` from the app's own directory, which the
 * renderer's existing `script-src 'self'` CSP already permits.
 */

/** The slice of Mermaid's API Geode calls. Structural, so no mermaid import lands here. */
export interface MermaidApi {
  initialize(config: unknown): void;
  render(
    id: string,
    text: string,
    container?: Element
  ): Promise<{ svg: string; diagramType?: string; bindFunctions?: (element: Element) => void }>;
}

/**
 * Wrap a one-shot loader in the memoization contract `loadMermaid` needs:
 * concurrent callers share a single in-flight load, a resolved load is reused
 * forever, and a rejected load clears the memo so a later diagram can retry
 * instead of being permanently poisoned by one transient failure.
 *
 * Exported (rather than inlined below) so the memoization rules are testable
 * without a DOM or a real 3MB script fetch.
 */
export function createMermaidLoader(load: () => Promise<MermaidApi>): () => Promise<MermaidApi> {
  let pending: Promise<MermaidApi> | null = null;
  return () => {
    if (pending) return pending;
    const attempt = load().catch((err) => {
      // Only clear the memo if this attempt is still the current one, so a
      // retry that has already started is not discarded by a late rejection.
      if (pending === attempt) pending = null;
      throw err;
    });
    pending = attempt;
    return attempt;
  };
}

/**
 * Resolve `dist/mermaid.js` relative to however the renderer bundle itself was
 * loaded, so the same code works from the dev checkout (`../../dist/...` in
 * src/renderer/index.html) and from a packaged app without a build-time
 * constant.
 */
export function mermaidScriptUrl(doc: Document = document): string {
  const renderer = doc.querySelector<HTMLScriptElement>('script[src*="renderer.js"]');
  const src = renderer?.getAttribute("src") ?? "../../dist/renderer.js";
  return src.replace(/renderer\.js(\?.*)?$/, "mermaid.js");
}

function injectMermaidScript(): Promise<MermaidApi> {
  return new Promise<MermaidApi>((resolve, reject) => {
    const existing = (globalThis as { mermaid?: MermaidApi }).mermaid;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement("script");
    script.src = mermaidScriptUrl();
    script.addEventListener("load", () => {
      const api = (globalThis as { mermaid?: MermaidApi }).mermaid;
      if (api) resolve(api);
      else reject(new Error("mermaid.js loaded but did not define globalThis.mermaid"));
    });
    script.addEventListener("error", () => {
      // Drop the failed tag so a retry injects a fresh one rather than
      // hitting the browser's cached failure for this element.
      script.remove();
      reject(new Error(`Failed to load ${script.src}`));
    });
    document.head.appendChild(script);
  });
}

/**
 * Load Mermaid, injecting the lazy bundle on first use.
 *
 * Re-exported from `api/obsidian.ts` as the Obsidian-compatible
 * `loadMermaid()` so community plugins can render diagrams with the same
 * instance Geode uses.
 */
export const loadMermaid: () => Promise<MermaidApi> = createMermaidLoader(injectMermaidScript);
