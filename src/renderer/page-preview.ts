import type { App } from "./app";
import { extractSection } from "./markdown/embed";
import { positionHoverElement } from "./tooltip";

const SHOW_DELAY_MS = 300;
const HIDE_GRACE_MS = 140;
const MAX_EXCERPT_CHARS = 5_000;

export interface PreviewTargetParts {
  linkpath: string;
  subpath: string;
}

export function splitPreviewTarget(target: string): PreviewTargetParts {
  const hash = target.indexOf("#");
  return {
    linkpath: target,
    subpath: hash === -1 ? "" : target.slice(hash),
  };
}

export function isExternalPreviewTarget(target: string): boolean {
  const value = target.trim();
  if (!value) return true;
  if (value.startsWith("//")) return true;
  return /^[a-z][a-z\d+.-]*:/i.test(value);
}

export function previewMarkdownExcerpt(text: string, subpath: string, maxChars: number): string {
  let excerpt = text;
  if (subpath.startsWith("#") && !subpath.startsWith("#^")) {
    excerpt = extractSection(text, subpath.slice(1));
  }
  const trimmed = excerpt.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function hasMarkdownHeading(text: string, heading: string): boolean {
  const target = heading.trim().toLowerCase();
  if (!target) return false;
  return text.split("\n").some((line) => {
    const match = line.match(/^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?$/);
    return match?.[2].trim().toLowerCase() === target;
  });
}

/** Keep preview parsing inert while still presenting Obsidian inline syntax as readable content. */
export function safePreviewMarkdownSource(source: string): string {
  source = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const code: string[] = [];
  source = source.replace(/```[\s\S]*?(```|$)|`[^`\n]*`/g, (match) => {
    code.push(match);
    return `\u0000PREVIEW_CODE_${code.length - 1}\u0000`;
  });
  source = source.replace(/%%[\s\S]*?%%/g, "");
  source = source.replace(/!\[\[[^\[\]\n]+\]\]/g, "");
  source = source.replace(/!\[([^\]\n]*)\](?:\([^\n)]*\)|\[[^\]\n]*\])/g, "$1");
  source = source.replace(
    /([\\]*)!\[([^\]\n]+)\](?![[(])/g,
    (match, backslashes: string, label: string) =>
      backslashes.length % 2 === 0 ? `${backslashes}${label}` : match
  );
  source = source.replace(/\[\[([^\[\]\n]+)\]\]/g, (_match, inner: string) => {
    const pipe = inner.indexOf("|");
    return pipe === -1 ? inner.replace(/#/g, " > ") : inner.slice(pipe + 1).trim();
  });
  // Authored HTML must reach the canonical renderer as text, never markup.
  // Code regions are restored afterwards so their delimiters/content retain
  // normal Markdown code semantics.
  source = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return source.replace(/\u0000PREVIEW_CODE_(\d+)\u0000/g, (_match, index) => code[Number(index)]);
}

async function renderSafePreviewMarkdown(
  app: App,
  markdown: string,
  el: HTMLElement,
  sourcePath: string
): Promise<void> {
  await app.markdownRenderer.render(safePreviewMarkdownSource(markdown), el, sourcePath);
  for (const unsafe of el.querySelectorAll(
    "script, style, link, meta, base, iframe, object, embed, form, input, button, select, textarea, video, audio, img, picture, source, track, canvas, svg, math, details, dialog"
  )) {
    unsafe.remove();
  }
  for (const child of el.querySelectorAll<HTMLElement>("*")) {
    for (const attr of [...child.attributes]) {
      // The preview is intentionally presentation-only. Removing every
      // authored/renderer attribute is stricter and more future-proof than a
      // fetch-attribute denylist (SVG xlink:href, legacy background, poster,
      // ping, formaction, and future URL-bearing attributes all disappear).
      child.removeAttribute(attr.name);
    }
    if (child instanceof HTMLAnchorElement) child.setAttribute("aria-disabled", "true");
  }
  el.inert = true;
}

interface PreviewTrigger {
  el: HTMLElement;
  target: string;
  editing: boolean;
}

/**
 * One cancellable hover-preview lifecycle owned by a MarkdownView. Both
 * Reading View and Live Preview delegate into it; the view supplies the
 * current source path so resolution remains correct after a file change.
 */
export class PagePreviewController {
  private card: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;
  private showTimer: number | null = null;
  private hideTimer: number | null = null;
  private generation = 0;
  private hovered: PreviewTrigger | null = null;
  private activeTrigger: PreviewTrigger | null = null;
  private destroyed = false;
  private stopActiveViewChange: (() => void) | null = null;

  private readonly onMouseOver = (event: MouseEvent): void => {
    const trigger = this.findTrigger(event.target);
    if (!trigger) {
      this.hovered = null;
      return;
    }
    this.hovered = trigger;
    this.clearHideTimer();
    if (!trigger.editing || this.isPreviewModifierHeld(event)) this.schedule(trigger);
  };

  private readonly onMouseOut = (event: MouseEvent): void => {
    const trigger = this.findTrigger(event.target);
    if (!trigger) return;
    const related = event.relatedTarget;
    if (related instanceof Node && trigger.el.contains(related)) return;
    if (related instanceof Node && this.card?.contains(related)) return;
    if (this.hovered?.el === trigger.el) this.hovered = null;
    if (this.card) this.scheduleHide();
    else this.cancelPending();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.hide();
      return;
    }
    if (this.isPreviewModifierKey(event) && this.hovered?.editing) {
      if (this.hovered.el.isConnected && this.hovered.el.matches(":hover")) this.schedule(this.hovered);
      else this.hovered = null;
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (
      this.isPreviewModifierKey(event) &&
      !this.isPreviewModifierHeld(event) &&
      (this.activeTrigger?.editing || this.hovered?.editing)
    ) {
      // Releasing the required modifier cancels this attempt, but the pointer
      // may still be over the same trigger. Preserve that trigger so a later
      // modifier press can intentionally re-arm without synthetic movement.
      this.hide(true);
    }
  };

  private readonly onScroll = (event: Event): void => {
    if (event.target instanceof Node && this.card?.contains(event.target)) return;
    // Scrolling invalidates both anchored coordinates and hover eligibility.
    // Programmatic scroll events do not reliably produce a matching mouseout.
    this.hide();
  };

  private readonly onResize = (): void => this.hide();

  private isPreviewModifierKey(event: KeyboardEvent): boolean {
    return event.key === (this.app.host.runtime.platform === "darwin" ? "Meta" : "Control");
  }

  private isPreviewModifierHeld(event: MouseEvent | KeyboardEvent): boolean {
    return this.app.host.runtime.platform === "darwin" ? event.metaKey : event.ctrlKey;
  }

  constructor(
    private readonly app: App,
    private readonly hostEl: HTMLElement,
    private readonly getSourcePath: () => string
  ) {
    hostEl.addEventListener("mouseover", this.onMouseOver);
    hostEl.addEventListener("mouseout", this.onMouseOut);
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("keyup", this.onKeyUp, true);
    document.addEventListener("scroll", this.onScroll, true);
    window.addEventListener("resize", this.onResize);
    this.stopActiveViewChange = app.workspace?.on("active-leaf-change", () => this.hide()) ?? null;
  }

  /** Cancel visible and in-flight work while leaving this view ready for its next file/mode. */
  hide(preserveHovered = false): void {
    this.generation += 1;
    this.clearShowTimer();
    this.clearHideTimer();
    this.activeTrigger = null;
    if (!preserveHovered) this.hovered = null;
    if (this.contentEl) this.app.markdownRenderer.dispose(this.contentEl);
    this.contentEl = null;
    this.card?.remove();
    this.card = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hide();
    this.hovered = null;
    this.hostEl.removeEventListener("mouseover", this.onMouseOver);
    this.hostEl.removeEventListener("mouseout", this.onMouseOut);
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("keyup", this.onKeyUp, true);
    document.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("resize", this.onResize);
    this.stopActiveViewChange?.();
    this.stopActiveViewChange = null;
  }

  private findTrigger(node: EventTarget | null): PreviewTrigger | null {
    if (!(node instanceof Element)) return null;
    const el = node.closest<HTMLElement>(
      ".markdown-reading-view a, .markdown-source-view .cm-live-wikilink[data-href], .markdown-source-view .cm-live-extlink[data-href]"
    );
    if (!el || !this.hostEl.contains(el)) return null;
    if (el.classList.contains("tag")) return null;
    if (el.closest(".markdown-embed, .cm-embed-widget")) return null;
    let target = el.dataset.href?.trim() ?? el.getAttribute("href")?.trim() ?? "";
    try { target = decodeURIComponent(target); } catch { return null; }
    if (isExternalPreviewTarget(target)) return null;
    return { el, target, editing: !el.closest(".markdown-reading-view") };
  }

  private schedule(trigger: PreviewTrigger): void {
    if (this.activeTrigger && this.activeTrigger.el !== trigger.el) this.removeCard();
    this.clearShowTimer();
    this.clearHideTimer();
    this.generation += 1;
    const generation = this.generation;
    this.activeTrigger = trigger;
    this.showTimer = window.setTimeout(() => {
      this.showTimer = null;
      void this.show(trigger, generation);
    }, SHOW_DELAY_MS);
  }

  private async show(trigger: PreviewTrigger, generation: number): Promise<void> {
    const sourcePath = this.getSourcePath();
    const { subpath } = splitPreviewTarget(trigger.target);
    // Block-reference extraction is not yet supported; declining the preview
    // is safer than showing the whole note under a misleading ^block path.
    if (subpath.startsWith("#^")) return;
    const file = this.app.metadataCache.getFirstLinkpathDest(trigger.target, sourcePath);
    if (!file || file.extension !== "md") return;
    let text: string;
    try {
      // Hover previews favor freshness over the cache: a target may have
      // changed externally just before the filesystem event invalidates the
      // warmed metadata cache.
      text = await this.app.vault.read(file);
    } catch {
      return;
    }
    if (!this.isCurrent(trigger, generation)) return;

    const card = document.createElement("aside");
    card.className = "page-preview markdown-rendered";
    card.setAttribute("role", "tooltip");
    const header = document.createElement("div");
    header.className = "page-preview-header";
    const title = document.createElement("div");
    title.className = "page-preview-title";
    title.textContent = file.basename;
    const path = document.createElement("div");
    path.className = "page-preview-path";
    const displaySubpath = subpath && hasMarkdownHeading(text, subpath.slice(1)) ? subpath : "";
    path.textContent = `${file.path}${displaySubpath}`;
    header.append(title, path);
    const content = document.createElement("div");
    content.className = "page-preview-content";
    card.append(header, content);

    const excerpt = previewMarkdownExcerpt(text, subpath, MAX_EXCERPT_CHARS);
    try {
      await renderSafePreviewMarkdown(this.app, excerpt, content, file.path);
    } catch (error) {
      this.app.markdownRenderer.dispose(content);
      console.error("Failed to render page preview", error);
      return;
    }
    if (!this.isCurrent(trigger, generation)) {
      this.app.markdownRenderer.dispose(content);
      return;
    }

    this.removeCard();
    this.card = card;
    this.contentEl = content;
    card.addEventListener("mouseenter", () => this.clearHideTimer());
    card.addEventListener("mouseleave", (event) => {
      const related = event.relatedTarget;
      if (related instanceof Node && trigger.el.contains(related)) return;
      this.scheduleHide();
    });
    document.body.appendChild(card);
    positionHoverElement(card, trigger.el, "bottom");
  }

  private isCurrent(trigger: PreviewTrigger, generation: number): boolean {
    return (
      !this.destroyed &&
      generation === this.generation &&
      this.activeTrigger?.el === trigger.el &&
      trigger.el.isConnected
    );
  }

  private scheduleHide(): void {
    this.clearHideTimer();
    this.hideTimer = window.setTimeout(() => this.hide(), HIDE_GRACE_MS);
  }

  private cancelPending(): void {
    this.generation += 1;
    this.clearShowTimer();
    this.activeTrigger = null;
  }

  private clearShowTimer(): void {
    if (this.showTimer === null) return;
    window.clearTimeout(this.showTimer);
    this.showTimer = null;
  }

  private clearHideTimer(): void {
    if (this.hideTimer === null) return;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private removeCard(): void {
    if (this.contentEl) this.app.markdownRenderer.dispose(this.contentEl);
    this.contentEl = null;
    this.card?.remove();
    this.card = null;
  }
}
