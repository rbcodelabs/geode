import type { App } from "../../app";
import { Plugin as GeodePlugin } from "../../plugin";
import type { PluginManifest } from "../../plugin-manifest";
import { setIcon } from "../../api/icons";
import type { Menu } from "../../api/obsidian";
import type { TFile } from "../../types";
import type { WorkspaceLeaf } from "../../workspace";
import { SlidesState, splitSlides } from "./slides";

export const SLIDES_PLUGIN_MANIFEST: PluginManifest = {
  id: "slides",
  name: "Slides",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Present your notes as slides.",
  author: "Geode",
};

/**
 * Slides core plugin: "Start presentation" (command and note-tab context menu)
 * opens a full-window overlay that shows one slide of the note at a time,
 * rendered by the same reading-view renderer as Reading mode.
 */
export class SlidesPlugin extends GeodePlugin {
  private presentation: SlidesPresentation | null = null;

  constructor(app: App) {
    super(app, SLIDES_PLUGIN_MANIFEST);
  }

  onload(): void {
    this.addCommand({
      id: "start",
      name: "Start presentation",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.start(file, this.app.workspace.activeLeaf);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TFile, source: string, leaf?: WorkspaceLeaf) => {
        if (source !== "tab-header" || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Start presentation")
            .setIcon("presentation")
            .onClick(() => void this.start(file, leaf ?? null))
        );
      })
    );
  }

  onunload(): void {
    this.end();
  }

  /** Whether a presentation is currently showing. */
  get isPresenting(): boolean {
    return this.presentation !== null;
  }

  async start(file: TFile, leaf: WorkspaceLeaf | null): Promise<void> {
    this.end();
    // Prefer the open editor's live text so unsaved edits are presented.
    const view = leaf?.view as { getFile?: () => TFile | null; getText?: () => string } | undefined;
    const text =
      view?.getFile?.()?.path === file.path && typeof view.getText === "function"
        ? view.getText()
        : await this.app.vault.read(file);
    const slides = splitSlides(text);
    if (slides.length === 0) {
      this.app.notify("This note has no content to present.");
      return;
    }
    const presentation = new SlidesPresentation(this.app, file, slides, () => {
      if (this.presentation === presentation) this.presentation = null;
    });
    this.presentation = presentation;
    await presentation.open();
  }

  end(): void {
    this.presentation?.close();
    this.presentation = null;
  }
}

class SlidesPresentation {
  private readonly state: SlidesState;
  private readonly overlay = document.createElement("div");
  private readonly slideEl = document.createElement("div");
  private readonly prevBtn = document.createElement("button");
  private readonly nextBtn = document.createElement("button");
  private closed = false;
  private renderToken = 0;
  private renderedEl: HTMLElement | null = null;

  constructor(
    private readonly app: App,
    private readonly file: TFile,
    private readonly slides: string[],
    private readonly onClosed: () => void
  ) {
    this.state = new SlidesState(slides.length);
  }

  async open(): Promise<void> {
    const overlay = this.overlay;
    overlay.className = "slides-presentation";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", `Presentation: ${this.file.basename}`);
    overlay.setAttribute("aria-modal", "true");

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "slides-close clickable-icon";
    closeBtn.setAttribute("aria-label", "Close presentation");
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.close());

    this.slideEl.className = "slides-slide markdown-rendered";

    const nav = document.createElement("div");
    nav.className = "slides-nav";
    for (const [btn, cls, label, icon, step] of [
      [this.prevBtn, "slides-prev", "Previous slide", "arrow-left", () => this.go(-1)],
      [this.nextBtn, "slides-next", "Next slide", "arrow-right", () => this.go(1)],
    ] as const) {
      btn.type = "button";
      btn.className = `slides-nav-button clickable-icon ${cls}`;
      btn.setAttribute("aria-label", label);
      setIcon(btn, icon);
      btn.addEventListener("click", step);
      nav.appendChild(btn);
    }

    overlay.append(closeBtn, this.slideEl, nav);
    document.body.appendChild(overlay);
    window.addEventListener("keydown", this.onKeyDown, true);
    await this.show();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener("keydown", this.onKeyDown, true);
    if (this.renderedEl) this.app.markdownRenderer.dispose(this.renderedEl);
    this.renderedEl = null;
    this.overlay.remove();
    this.onClosed();
  }

  private go(delta: 1 | -1): void {
    const moved = delta === 1 ? this.state.next() : this.state.previous();
    if (moved) void this.show();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    let handled = true;
    switch (event.key) {
      case "ArrowRight":
      case " ":
        this.go(1);
        break;
      case "ArrowLeft":
        this.go(-1);
        break;
      case "Escape":
        this.close();
        break;
      default:
        handled = false;
    }
    // Capture phase + stopPropagation keeps the editor and global keymap from
    // also acting on keys the presentation owns.
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private async show(): Promise<void> {
    const token = ++this.renderToken;
    const { index } = this.state;
    const next = document.createElement("div");
    next.className = "slides-content";
    if (this.renderedEl) this.app.markdownRenderer.dispose(this.renderedEl);
    this.renderedEl = next;
    this.slideEl.replaceChildren(next);
    delete this.overlay.dataset.slideReady;
    this.overlay.dataset.slideIndex = String(index);
    this.overlay.dataset.slideCount = String(this.slides.length);
    this.prevBtn.disabled = !this.state.canPrevious;
    this.nextBtn.disabled = !this.state.canNext;
    await this.app.markdownRenderer.render(this.slides[index], next, this.file.path);
    // A newer navigation superseded this render; its element is already gone.
    if (token !== this.renderToken || this.closed) return;
    this.overlay.dataset.slideReady = String(index);
  }
}
