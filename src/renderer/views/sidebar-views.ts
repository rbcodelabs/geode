import type { App } from "../app";
import type { View } from "../workspace";
import { TFile } from "../types";

abstract class SidebarView implements View {
  abstract readonly viewType: string;
  containerEl: HTMLElement;
  protected bodyEl: HTMLElement;
  protected file: TFile | null = null;

  constructor(protected app: App, title: string) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "sidebar-view";
    const header = document.createElement("div");
    header.className = "sidebar-view-header";
    header.innerHTML = `<span class="sidebar-view-title">${title}</span>`;
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "sidebar-view-body";
    this.containerEl.appendChild(header);
    this.containerEl.appendChild(this.bodyEl);

    app.workspace.on("file-open", (file: TFile | null) => {
      this.file = file;
      this.render();
    });
    app.metadataCache.on("changed", () => this.render());
    app.metadataCache.on("resolved", () => this.render());
  }

  abstract getDisplayText(): string;
  abstract getIcon(): string;
  abstract render(): void;

  onOpen(): void {
    this.file = this.app.workspace.getActiveFile();
    this.render();
  }

  onClose(): void {}

  protected empty(message: string) {
    this.bodyEl.innerHTML = `<div class="pane-empty">${message}</div>`;
  }
}

export class BacklinksView extends SidebarView {
  readonly viewType = "backlinks";

  constructor(app: App) {
    super(app, "Backlinks");
  }

  getDisplayText(): string {
    return "Backlinks";
  }

  getIcon(): string {
    return "link";
  }

  render(): void {
    if (!this.file || this.file.extension !== "md") {
      this.empty("No file is open.");
      return;
    }
    const file = this.file;
    const linked = this.app.metadataCache.getBacklinksWithContext(file);
    const unlinked = this.app.metadataCache.getUnlinkedMentions(file);
    this.bodyEl.innerHTML = "";

    this.renderSection(
      `Linked mentions (${linked.reduce((n, b) => n + b.count, 0)})`,
      "No backlinks found.",
      linked.map((b) => ({ source: b.source, count: b.count, snippets: b.snippets }))
    );
    this.renderSection(
      `Unlinked mentions (${unlinked.reduce((n, u) => n + u.mentions.length, 0)})`,
      "No unlinked mentions found.",
      unlinked.map((u) => ({
        source: u.source,
        count: u.mentions.length,
        snippets: u.mentions.map((m) => m.snippet),
      }))
    );
  }

  private renderSection(
    headingText: string,
    emptyText: string,
    entries: { source: TFile; count: number; snippets: string[] }[]
  ): void {
    const heading = document.createElement("div");
    heading.className = "pane-section-header";
    heading.textContent = headingText;
    this.bodyEl.appendChild(heading);
    if (!entries.length) {
      const none = document.createElement("div");
      none.className = "pane-empty";
      none.textContent = emptyText;
      this.bodyEl.appendChild(none);
      return;
    }
    for (const { source, count, snippets } of entries) {
      const row = document.createElement("div");
      row.className = "pane-result nav-item";
      const title = document.createElement("span");
      title.className = "nav-item-title";
      title.textContent = source.basename;
      const badge = document.createElement("span");
      badge.className = "pane-result-count";
      badge.textContent = String(count);
      row.append(title, badge);
      row.addEventListener("click", (e) => this.app.openFile(source, e.metaKey || e.ctrlKey));
      this.bodyEl.appendChild(row);

      for (const snippet of snippets) {
        const snippetEl = document.createElement("div");
        snippetEl.className = "pane-result-context";
        snippetEl.textContent = snippet; // textContent, not innerHTML: note content is untrusted.
        snippetEl.addEventListener("click", (e) => this.app.openFile(source, e.metaKey || e.ctrlKey));
        this.bodyEl.appendChild(snippetEl);
      }
    }
  }
}

export class OutlineView extends SidebarView {
  readonly viewType = "outline";

  constructor(app: App) {
    super(app, "Outline");
  }

  getDisplayText(): string {
    return "Outline";
  }

  getIcon(): string {
    return "list";
  }

  render(): void {
    if (!this.file || this.file.extension !== "md") {
      this.empty("No file is open.");
      return;
    }
    const headings = this.app.metadataCache.getHeadings(this.file);
    if (!headings.length) {
      this.empty("No headings in this note.");
      return;
    }
    this.bodyEl.innerHTML = "";
    for (const h of headings) {
      const row = document.createElement("div");
      row.className = "pane-result nav-item outline-item";
      row.style.paddingLeft = `${(h.level - 1) * 14 + 8}px`;
      row.innerHTML = `<span class="nav-item-title">${h.heading}</span>`;
      row.addEventListener("click", () => {
        this.app.revealOffsetInActiveMarkdownView(this.file!, h.position.start.offset);
      });
      this.bodyEl.appendChild(row);
    }
  }
}

export class TagPaneView extends SidebarView {
  readonly viewType = "tag-pane";

  constructor(app: App) {
    super(app, "Tags");
  }

  getDisplayText(): string {
    return "Tags";
  }

  getIcon(): string {
    return "tags";
  }

  render(): void {
    const tags = [...this.app.metadataCache.getAllTags().entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    if (!tags.length) {
      this.empty("No tags in this vault.");
      return;
    }
    this.bodyEl.innerHTML = "";
    for (const [tag, count] of tags) {
      const row = document.createElement("div");
      row.className = "pane-result nav-item";
      row.innerHTML = `<span class="nav-item-title tag-pane-tag">#${tag}</span><span class="pane-result-count">${count}</span>`;
      row.addEventListener("click", () => this.app.openSearch(`tag:${tag}`));
      this.bodyEl.appendChild(row);
    }
  }
}
