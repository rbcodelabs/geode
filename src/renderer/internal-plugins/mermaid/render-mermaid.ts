import type { App } from "../../app";
import { loadMermaid } from "./load-mermaid";
import { buildMermaidConfig, readGeodeThemeVars } from "./theme";

/**
 * The single Mermaid render path, shared by Reading view (via the code-block
 * processor in `mermaid-plugin.ts`) and Live Preview (via `MermaidWidget` in
 * `markdown/live-preview.ts`). Both modes go through this function so their
 * output, theming, error handling, and internal-link wiring cannot drift.
 */

let renderSeq = 0;

/** Class on the element `renderMermaid` fills; also the styling hook in styles/app.css. */
export const MERMAID_BLOCK_CLASS = "mermaid-block";

/**
 * Render `source` as a Mermaid diagram into `container`, replacing whatever it
 * held.
 *
 * Never throws. Reading view's `runCodeBlockProcessors` try/catches each block
 * already, but Live Preview's widget path has no such guard, and a diagram the
 * user is mid-way through typing is *expected* to be malformed — so a parse
 * failure renders an inline error block instead of propagating.
 */
export async function renderMermaid(
  source: string,
  container: HTMLElement,
  app: App,
  sourcePath: string
): Promise<void> {
  container.classList.add(MERMAID_BLOCK_CLASS);
  const id = `geode-mermaid-${++renderSeq}`;
  try {
    const mermaid = await loadMermaid();
    mermaid.initialize(buildMermaidConfig(readGeodeThemeVars(), app.isDarkMode()));
    const { svg, bindFunctions } = await mermaid.render(id, source.trim());
    container.classList.remove("is-error");
    container.innerHTML = svg;
    // Mermaid's `click` directives are inert until this runs — the docs call
    // this out explicitly, and a missed call fails silently.
    bindFunctions?.(container);
    wireInternalLinks(container, app, sourcePath);
  } catch (err) {
    renderMermaidError(container, err);
  } finally {
    // Mermaid renders into a detached scratch element when no container is
    // passed and removes it itself on success; a throw can leave it parented
    // to <body>. Sweep it so failed blocks don't accumulate stray nodes.
    document.getElementById(`d${id}`)?.remove();
  }
}

/** Replace `container`'s contents with an inline error block describing `err`. */
export function renderMermaidError(container: HTMLElement, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  container.classList.add(MERMAID_BLOCK_CLASS, "is-error");
  container.replaceChildren();
  const title = document.createElement("div");
  title.className = "mermaid-error-title";
  title.textContent = "Mermaid diagram error";
  const detail = document.createElement("pre");
  detail.className = "mermaid-error-detail";
  detail.textContent = message;
  container.append(title, detail);
}

/**
 * Wire nodes the diagram tagged with Mermaid's `class NodeA,NodeB
 * internal-link;` directive to Geode's link router, matching the behavior
 * `docs/spec/01-core-app.md` documents. The node's own label text is the link
 * target, so `A[Roadmap]:::internal-link` opens `Roadmap`.
 *
 * Mermaid emits a user class either as a plain class on the node's `<g>` or,
 * for `:::`-style shorthand, on a descendant, so both are matched.
 */
function wireInternalLinks(container: HTMLElement, app: App, sourcePath: string): void {
  for (const node of container.querySelectorAll<SVGElement>(".internal-link")) {
    const target = (node.textContent ?? "").trim();
    if (!target) continue;
    node.classList.add("is-clickable");
    node.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void app.openLink(target, sourcePath, ev.metaKey || ev.ctrlKey);
    });
  }
}

/**
 * Subscribe `rerender` to theme flips. `App.applySettings()` triggers
 * `css-change` (Obsidian's own event name) after swapping the
 * `theme-dark`/`theme-light` body class, so already-rendered diagrams restyle
 * instead of keeping the colors they were born with. Returns an unsubscribe.
 */
export function onThemeChange(app: App, rerender: () => void): () => void {
  return app.workspace.on("css-change", rerender);
}
