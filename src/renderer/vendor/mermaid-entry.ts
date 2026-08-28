/**
 * Lazy-loaded Mermaid chunk — a *separate* esbuild entry point that builds to
 * `dist/mermaid.js` (see esbuild.config.mjs).
 *
 * Mermaid and its transitive deps (d3, dagre, cytoscape) are several megabytes.
 * The renderer is bundled as a single-outfile IIFE, so esbuild code-splitting
 * is unavailable and a plain `import "mermaid"` anywhere in the renderer graph
 * would put all of that in every cold start. Isolating it here keeps
 * `dist/renderer.js` flat; `internal-plugins/mermaid/load-mermaid.ts` injects
 * this file as a `<script>` the first time a diagram is actually rendered and
 * picks the library up off the global set below.
 *
 * Nothing in the renderer graph may import this module directly — doing so
 * would pull Mermaid straight back into the cold-start bundle, silently
 * undoing the split.
 */
import mermaid from "mermaid";

(globalThis as { mermaid?: unknown }).mermaid = mermaid;
