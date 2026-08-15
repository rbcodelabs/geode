import { Component } from "../component";

/**
 * Registry + types backing Geode's Obsidian-compatible Markdown
 * reading-view processor API (`Plugin.registerMarkdownCodeBlockProcessor`,
 * `Plugin.registerMarkdownPostProcessor`). Kept as a leaf module (only
 * depends on `Component`) so the pure registry logic is unit-testable in a
 * Node environment and so `app.ts` / `markdown/render.ts` can import it
 * without a circular dependency on the `api/obsidian` compat surface — which
 * re-exports these symbols to plugins.
 */

/** Section-level source mapping for a rendered element. Mirrors Obsidian's `MarkdownSectionInformation`. */
export interface MarkdownSectionInformation {
  /** The full source text of the file being rendered. */
  text: string;
  /** First source line of the section (0-based, inclusive). */
  lineStart: number;
  /** Last source line of the section (0-based, inclusive). */
  lineEnd: number;
}

/**
 * A `Component` bound to a container element, handed to reading-view
 * processors so plugins can attach child lifecycles (event listeners,
 * intervals, sub-renders) that get cleaned up when the container is torn
 * down. Mirrors Obsidian's `MarkdownRenderChild`.
 */
export class MarkdownRenderChild extends Component {
  containerEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    super();
    this.containerEl = containerEl;
  }
}

/**
 * Context passed to every reading-view code-block/post processor. Mirrors
 * Obsidian's `MarkdownPostProcessorContext` (the subset plugins actually
 * consume — obsidian-tasks reads `sourcePath`, `frontmatter`, `addChild`,
 * and `getSectionInfo`).
 */
export interface MarkdownPostProcessorContext {
  docId?: string;
  /** Vault-relative path of the note being rendered (may be "" for detached renders). */
  sourcePath: string;
  /** Parsed frontmatter of the source note, or null when unavailable. */
  frontmatter: any;
  /** Attach a child component whose lifecycle is tied to this render. */
  addChild(child: MarkdownRenderChild): void;
  /** Best-effort mapping of a rendered element back to its source section (may return null). */
  getSectionInfo(el: HTMLElement): MarkdownSectionInformation | null;
}

/** A reading-view code-block processor: `(source, el, ctx)`. */
export type MarkdownCodeBlockProcessor = (
  source: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext
) => void | Promise<any>;

/** A reading-view post processor: `(el, ctx)` with a `sortOrder` controlling run order. */
export interface MarkdownPostProcessor {
  (el: HTMLElement, ctx: MarkdownPostProcessorContext): void | Promise<any>;
  sortOrder: number;
}

/**
 * Holds the code-block and whole-document post processors registered by
 * plugins. Pure data structure with no DOM dependency: `markdown/render.ts`
 * queries it during reading-view rendering; `App` owns one instance.
 */
export class MarkdownProcessorRegistry {
  private codeBlock = new Map<string, MarkdownCodeBlockProcessor>();
  private postProcessors: MarkdownPostProcessor[] = [];

  /** Register (or replace) the processor for a fenced code-block language. */
  registerCodeBlock(lang: string, processor: MarkdownCodeBlockProcessor): void {
    this.codeBlock.set(lang, processor);
  }

  /**
   * Remove the code-block processor for `lang`. If `processor` is given, only
   * removes it when it's still the registered one (so a later plugin that
   * claimed the same language isn't clobbered by an earlier plugin's unload).
   */
  unregisterCodeBlock(lang: string, processor?: MarkdownCodeBlockProcessor): void {
    if (processor === undefined || this.codeBlock.get(lang) === processor) {
      this.codeBlock.delete(lang);
    }
  }

  getCodeBlock(lang: string): MarkdownCodeBlockProcessor | undefined {
    return this.codeBlock.get(lang);
  }

  hasCodeBlocks(): boolean {
    return this.codeBlock.size > 0;
  }

  /**
   * Register a post processor, inserting it so the list stays sorted by
   * ascending `sortOrder` (stable for equal orders — earlier registrations
   * run first). Returns the processor (with `sortOrder` stamped on) so the
   * caller can later unregister it, matching Obsidian's return contract.
   */
  registerPostProcessor(
    processor: MarkdownPostProcessor,
    sortOrder = 0
  ): MarkdownPostProcessor {
    processor.sortOrder = sortOrder;
    let i = this.postProcessors.length;
    while (i > 0 && this.postProcessors[i - 1].sortOrder > sortOrder) i--;
    this.postProcessors.splice(i, 0, processor);
    return processor;
  }

  unregisterPostProcessor(processor: MarkdownPostProcessor): void {
    const i = this.postProcessors.indexOf(processor);
    if (i !== -1) this.postProcessors.splice(i, 1);
  }

  /** Post processors in ascending `sortOrder`. */
  postProcessorsInOrder(): readonly MarkdownPostProcessor[] {
    return this.postProcessors;
  }
}
