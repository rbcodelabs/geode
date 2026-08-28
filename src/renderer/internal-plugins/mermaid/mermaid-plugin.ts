import type { App } from "../../app";
import { MarkdownRenderChild } from "../../markdown/processor-registry";
import type { MarkdownCodeBlockProcessor } from "../../markdown/processor-registry";
import { Plugin as GeodePlugin } from "../../plugin";
import type { PluginManifest } from "../../plugin-manifest";
import { MERMAID_LANG } from "./fence";
import { onThemeChange, renderMermaid } from "./render-mermaid";

/**
 * Mermaid rendering, implemented as an *internal plugin* rather than a branch
 * inside the core renderer.
 *
 * It consumes exactly the public API a community plugin would
 * (`registerMarkdownCodeBlockProcessor`), which dogfoods that extension point
 * on a real feature and keeps `markdown/render.ts` free of per-language
 * special cases. Geode has no core-plugin registry yet, so `App` instantiates
 * this one directly during vault open; if more internal features adopt the
 * pattern, that single call site is where a registry would slot in.
 *
 * Note the base class: `Plugin` from `../../plugin`, *not* the richer one in
 * `api/obsidian.ts`. That module imports `App`, and `markdown/
 * processor-registry.ts` deliberately stays a leaf to avoid exactly that
 * cycle. `App` exposes `registerMarkdownCodeBlockProcessor` directly, so
 * nothing is lost.
 */
export const MERMAID_PLUGIN_MANIFEST: PluginManifest = {
  id: "mermaid",
  name: "Mermaid",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Renders ```mermaid code blocks as diagrams.",
  author: "Geode",
};

export class MermaidPlugin extends GeodePlugin {
  constructor(app: App) {
    super(app, MERMAID_PLUGIN_MANIFEST);
  }

  onload(): void {
    const handler: MarkdownCodeBlockProcessor = (source, el, ctx) => {
      const child = new MermaidRenderChild(el, source, this.app, ctx.sourcePath);
      // Ties the diagram's theme subscription to the render container's
      // lifecycle, so it is torn down when reading view re-renders.
      ctx.addChild(child);
      return child.rendered;
    };
    this.app.registerMarkdownCodeBlockProcessor(MERMAID_LANG, handler);
    this.register(() => this.app.unregisterMarkdownCodeBlockProcessor(MERMAID_LANG, handler));
  }
}

/**
 * One rendered diagram in Reading view. Renders on load and re-renders on
 * `css-change` so a light/dark flip restyles existing diagrams.
 */
class MermaidRenderChild extends MarkdownRenderChild {
  /** Resolves when the initial render settles, so the processor can be awaited. */
  rendered: Promise<void> = Promise.resolve();

  constructor(
    containerEl: HTMLElement,
    private source: string,
    private app: App,
    private sourcePath: string
  ) {
    super(containerEl);
  }

  onload(): void {
    this.rendered = this.render();
    this.registerEvent(onThemeChange(this.app, () => void this.render()));
  }

  private render(): Promise<void> {
    return renderMermaid(this.source, this.containerEl, this.app, this.sourcePath);
  }
}
