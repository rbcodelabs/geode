import type { App } from "../app";
import { projectCanvasForSearch } from "../canvas/canvas-data";
import type { View } from "../workspace";
import { TFile, TagCache } from "../types";
import { setIcon } from "../api/icons";
import { parseQuery, matchFileAgainstTerms, type SearchMatch as PortableSearchMatch, type SearchTerm } from "../../wiki/search";

/**
 * The query primitives moved to the portable engine (`src/wiki/search.ts`):
 * they never needed the DOM, and the local wiki provider needs them too.
 * Re-exported here, with the file type bound back to `TFile`, so every desktop
 * call site and test keeps working against one implementation.
 */
export { parseQuery, matchFileAgainstTerms } from "../../wiki/search";
export type { SearchTerm } from "../../wiki/search";
export type SearchMatch = PortableSearchMatch<TFile>;

export class SearchView implements View {
  readonly viewType = "search";
  containerEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private resultsEl: HTMLElement;
  private runToken = 0;

  constructor(private app: App) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "search-view sidebar-view";
    const header = document.createElement("div");
    header.className = "sidebar-view-header";
    header.innerHTML = `<span class="sidebar-view-title">Search</span>`;
    // Three-dot actions affordance (spec: "Search pane: three-dot menu next to
    // the result count → bookmark the search").
    const actions = document.createElement("span");
    actions.className = "sidebar-view-actions";
    const moreBtn = document.createElement("button");
    moreBtn.className = "clickable-icon";
    moreBtn.title = "More options";
    setIcon(moreBtn, "more-horizontal");
    moreBtn.addEventListener("click", (e) => {
      this.app.showMenu(
        e,
        [
          {
            title: "Bookmark search",
            icon: "bookmark",
            action: () => void this.app.addSearchBookmark(this.inputEl.value),
          },
        ],
        { anchor: moreBtn, horizontalAlign: "end" }
      );
    });
    actions.appendChild(moreBtn);
    header.appendChild(actions);
    this.inputEl = document.createElement("input");
    this.inputEl.className = "search-input";
    this.inputEl.placeholder = "Search (tag:, path:, file:, \"phrase\", -not, /regex/)…";
    this.inputEl.addEventListener("input", () => this.runDebounced());
    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "search-results sidebar-view-body";
    this.containerEl.appendChild(header);
    this.containerEl.appendChild(this.inputEl);
    this.containerEl.appendChild(this.resultsEl);
  }

  getDisplayText(): string {
    return "Search";
  }

  getIcon(): string {
    return "search";
  }

  onOpen(): void {
    this.inputEl.focus();
  }

  onClose(): void {}

  setQuery(query: string) {
    this.inputEl.value = query;
    this.run();
  }

  private debounceTimer: number | null = null;
  private runDebounced() {
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => this.run(), 250);
  }

  private async run() {
    const token = ++this.runToken;
    const terms = parseQuery(this.inputEl.value);
    if (!terms.length) {
      this.resultsEl.innerHTML = "";
      return;
    }
    const matches: SearchMatch[] = [];
    const markdownPaths = new Set(this.app.vault.getMarkdownFiles().map((file) => file.path));
    const files = this.app.vault.getFiles().filter((file) => markdownPaths.has(file.path) || file.extension === "canvas");
    for (const file of files) {
      let content: string | null = null;
      const needsContent = terms.some((t) => ["text", "content", "line"].includes(t.op) || t.regex);
      if (needsContent) {
        try {
          const source = await this.app.vault.cachedRead(file);
          content = file.extension === "canvas" ? projectCanvasForSearch(source) : source;
          if (file.extension === "canvas" && content == null) continue;
        } catch {
          continue;
        }
      }
      if (token !== this.runToken) return; // superseded by newer query
      const result = this.matchFile(file, content, terms);
      if (result) matches.push(result);
      if (matches.length >= 200) break;
    }
    this.renderResults(matches, token);
  }

  private matchFile(file: TFile, content: string | null, terms: SearchTerm[]): SearchMatch | null {
    const getTags = (f: TFile) => f.extension === "canvas"
      ? []
      : this.app.metadataCache.getFileCache(f)?.tags ?? [];
    return matchFileAgainstTerms(file, content, terms, getTags);
  }

  private renderResults(matches: SearchMatch[], token: number) {
    if (token !== this.runToken) return;
    this.resultsEl.innerHTML = "";
    const count = document.createElement("div");
    count.className = "pane-section-header";
    count.textContent = `${matches.length} file${matches.length === 1 ? "" : "s"}`;
    this.resultsEl.appendChild(count);
    for (const match of matches) {
      const fileEl = document.createElement("div");
      fileEl.className = "search-result";
      const title = document.createElement("div");
      title.className = "pane-result nav-item search-result-file";
      title.innerHTML = `<span class="nav-item-title">${match.file.basename}</span>`;
      title.addEventListener("click", (e) =>
        this.app.openFile(match.file, e.metaKey || e.ctrlKey)
      );
      fileEl.appendChild(title);
      for (const snip of match.snippets.slice(0, 5)) {
        const s = document.createElement("div");
        s.className = "search-result-snippet";
        s.textContent = snip.text;
        s.addEventListener("click", () =>
          this.app.revealOffsetInActiveMarkdownView(match.file, snip.offset)
        );
        fileEl.appendChild(s);
      }
      this.resultsEl.appendChild(fileEl);
    }
  }
}
