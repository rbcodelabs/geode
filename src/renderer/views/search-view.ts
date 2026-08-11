import type { App } from "../app";
import type { View } from "../workspace";
import { TFile, TagCache } from "../types";

export interface SearchTerm {
  op: "text" | "file" | "path" | "tag" | "content" | "line";
  value: string;
  negated: boolean;
  regex: RegExp | null;
}

export interface SearchMatch {
  file: TFile;
  snippets: { text: string; offset: number }[];
}

/** Parse a query into terms. Supports operators, "phrases", -negation, /regex/. */
export function parseQuery(query: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const re = /(-)?(?:(file|path|tag|content|line):)?(?:"([^"]*)"|\/((?:[^\/\\]|\\.)+)\/|(\S+))/g;
  for (const m of query.matchAll(re)) {
    const negated = !!m[1];
    const op = (m[2] as SearchTerm["op"]) || "text";
    let value = m[3] ?? m[5] ?? "";
    let regex: RegExp | null = null;
    if (m[4] !== undefined) {
      try {
        regex = new RegExp(m[4], "gi");
      } catch {
        value = m[4];
      }
    }
    if (!value && !regex) continue;
    terms.push({ op, value: value.toLowerCase(), negated, regex });
  }
  return terms;
}

function snippetAt(content: string, index: number, len: number): { text: string; offset: number } {
  const lineStart = content.lastIndexOf("\n", index) + 1;
  let lineEnd = content.indexOf("\n", index + len);
  if (lineEnd === -1) lineEnd = content.length;
  return { text: content.slice(lineStart, lineEnd).slice(0, 250), offset: index };
}

/**
 * Evaluate a parsed query's terms against a single file. Pure aside from the
 * injected `getTags` lookup (tag matching needs the metadata cache, which is
 * not available outside the app). All other operators only need `file` and
 * `content`, so this can run without any DOM/Electron dependency.
 */
export function matchFileAgainstTerms(
  file: TFile,
  content: string | null,
  terms: SearchTerm[],
  getTags: (file: TFile) => TagCache[]
): SearchMatch | null {
  const snippets: { text: string; offset: number }[] = [];
  const lower = content?.toLowerCase() ?? "";
  for (const term of terms) {
    let hit = false;
    switch (term.op) {
      case "file":
        hit = file.name.toLowerCase().includes(term.value);
        break;
      case "path":
        hit = file.path.toLowerCase().includes(term.value);
        break;
      case "tag": {
        const tags = getTags(file);
        const want = term.value.replace(/^#/, "");
        hit = tags.some((t) => {
          const tl = t.tag.toLowerCase();
          return tl === want || tl.startsWith(want + "/");
        });
        break;
      }
      case "text":
      case "content":
      case "line": {
        if (content == null) break;
        if (term.regex) {
          term.regex.lastIndex = 0;
          const m = term.regex.exec(content);
          if (m) {
            hit = true;
            if (!term.negated) snippets.push(snippetAt(content, m.index, m[0].length));
          }
        } else {
          const idx = lower.indexOf(term.value);
          if (idx !== -1) {
            hit = true;
            if (!term.negated) snippets.push(snippetAt(content, idx, term.value.length));
          }
        }
        break;
      }
    }
    if (term.negated ? hit : !hit) return null;
  }
  return { file, snippets };
}

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
    return "🔍";
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
    for (const file of this.app.vault.getMarkdownFiles()) {
      let content: string | null = null;
      const needsContent = terms.some((t) => ["text", "content", "line"].includes(t.op) || t.regex);
      if (needsContent) {
        try {
          content = await this.app.vault.cachedRead(file);
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
    const getTags = (f: TFile) => this.app.metadataCache.getFileCache(f)?.tags ?? [];
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
