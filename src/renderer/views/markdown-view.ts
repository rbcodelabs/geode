import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  autocompletion,
  CompletionContext,
  CompletionResult,
  completionKeymap,
} from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { App } from "../app";
import { buildViewHeaderNavButtons, type View } from "../workspace";
import { setIcon } from "../api/icons";
import type { TFile } from "../types";
import { frontmatterEndOffset, livePreview } from "../markdown/live-preview";

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-header-1" },
  { tag: tags.heading2, class: "cm-header-2" },
  { tag: tags.heading3, class: "cm-header-3" },
  { tag: tags.heading4, class: "cm-header-4" },
  { tag: tags.heading5, class: "cm-header-5" },
  { tag: tags.heading6, class: "cm-header-6" },
  { tag: tags.strong, class: "cm-strong" },
  { tag: tags.emphasis, class: "cm-em" },
  { tag: tags.strikethrough, class: "cm-strikethrough" },
  { tag: tags.link, class: "cm-link" },
  { tag: tags.url, class: "cm-url" },
  { tag: tags.monospace, class: "cm-inline-code" },
  { tag: tags.quote, class: "cm-quote" },
  { tag: tags.list, class: "cm-list" },
  { tag: tags.meta, class: "cm-meta" },
  { tag: tags.comment, class: "cm-comment" },
]);

export type MarkdownMode = "live" | "source" | "reading";

/**
 * Pure comparison used to decide whether a `"modify"` event on the currently
 * open file represents a genuine external change (disk content differs from
 * what this view last knew to be on disk) versus an echo of this view's own
 * autosave write. Extracted as a standalone function so it's unit-testable
 * without a DOM/CodeMirror harness — see `MarkdownView.getLastKnownText()`
 * and the vault "modify" handler in `app.ts` for why content comparison
 * (rather than comparing against live, in-progress editor text) is required.
 */
export function hasExternalChange(diskText: string, lastKnownText: string): boolean {
  return diskText !== lastKnownText;
}

export class MarkdownView implements View {
  readonly viewType = "markdown";
  containerEl: HTMLElement;
  file: TFile | null = null;
  mode: MarkdownMode = "live";
  private lastEditingMode: "live" | "source" = "live";
  private editingCompartment = new Compartment();
  editor: EditorView | null = null;
  private headerEl: HTMLElement;
  private titleParentEl: HTMLElement;
  private titleEl: HTMLElement;
  private bodyEl: HTMLElement;
  private readingEl: HTMLElement;
  private readingContentEl: HTMLElement | null = null;
  private editorHostEl: HTMLElement;
  private saveTimer: number | null = null;
  private lastSavedText = "";

  constructor(private app: App) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "markdown-view";
    this.headerEl = document.createElement("div");
    this.headerEl.className = "view-header";

    const left = document.createElement("div");
    left.className = "view-header-left";
    left.appendChild(buildViewHeaderNavButtons());

    const titleContainer = document.createElement("div");
    titleContainer.className = "view-header-title-container mod-at-start mod-fade mod-at-end";
    this.titleParentEl = document.createElement("div");
    this.titleParentEl.className = "view-header-title-parent";

    this.titleEl = document.createElement("div");
    this.titleEl.className = "view-header-title";
    this.titleEl.contentEditable = "plaintext-only";
    this.titleEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.titleEl.blur();
      }
    });
    this.titleEl.addEventListener("blur", () => this.commitTitleRename());

    titleContainer.append(this.titleParentEl, this.titleEl);

    const actions = document.createElement("div");
    actions.className = "view-actions";
    const sourceBtn = document.createElement("button");
    sourceBtn.className = "view-mode-toggle clickable-icon view-action";
    sourceBtn.title = "Toggle Live Preview / Source mode";
    sourceBtn.setAttribute("aria-label", "Toggle Live Preview / Source mode");
    setIcon(sourceBtn, "code-2");
    sourceBtn.addEventListener("click", () => this.toggleSource());
    const modeBtn = document.createElement("button");
    modeBtn.className = "view-mode-toggle clickable-icon view-action";
    modeBtn.title = "Toggle reading view (Cmd/Ctrl+E)";
    modeBtn.setAttribute("aria-label", "Toggle reading view (Cmd/Ctrl+E)");
    setIcon(modeBtn, "book-open");
    modeBtn.addEventListener("click", () => this.toggleMode());
    actions.append(sourceBtn, modeBtn);

    this.headerEl.append(left, titleContainer, actions);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "markdown-view-body";
    this.editorHostEl = document.createElement("div");
    this.editorHostEl.className = "markdown-source-view";
    this.readingEl = document.createElement("div");
    this.readingEl.className = "markdown-reading-view markdown-rendered";
    this.bodyEl.appendChild(this.editorHostEl);
    this.bodyEl.appendChild(this.readingEl);
    this.containerEl.appendChild(this.headerEl);
    this.containerEl.appendChild(this.bodyEl);
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Untitled";
  }

  getIcon(): string {
    return "file-text";
  }

  getFile(): TFile | null {
    return this.file;
  }

  async setFile(file: TFile): Promise<void> {
    await this.flush();
    this.file = file;
    this.titleEl.textContent = file.basename;
    this.titleParentEl.innerHTML = "";
    if (file.parent) {
      for (const el of buildBreadcrumbs(file.parent)) this.titleParentEl.appendChild(el);
    }
    const text = await this.app.vault.read(file);
    this.lastSavedText = text;
    this.buildEditor(text);
    if (this.mode === "reading") await this.renderReading();
    this.applyMode();
  }

  private buildEditor(text: string) {
    this.editor?.destroy();
    const app = this.app;
    const view = this;

    const wikilinkCompletion = (ctx: CompletionContext): CompletionResult | null => {
      const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 200), ctx.pos);
      const open = before.lastIndexOf("[[");
      if (open === -1) return null;
      const fragment = before.slice(open + 2);
      if (fragment.includes("]]") || fragment.includes("\n")) return null;
      const from = ctx.pos - fragment.length;
      const files = app.vault.getMarkdownFiles();
      const options = files.map((f) => ({
        label: f.basename,
        detail: f.parent || undefined,
        apply: (v: EditorView, _c: unknown, fromPos: number, toPos: number) => {
          const insert = `${f.basename}]]`;
          v.dispatch({ changes: { from: fromPos, to: toPos, insert } });
        },
      }));
      return { from, options, validFor: /^[^\[\]]*$/ };
    };

    const initialCursorOffset =
      this.mode !== "source" ? frontmatterEndOffset(text) : null;

    const state = EditorState.create({
      doc: text,
      selection: EditorSelection.cursor(initialCursorOffset ?? 0),
      extensions: [
        history(),
        drawSelection(),
        highlightSelectionMatches(),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(mdHighlight),
        this.editingCompartment.of(
          this.mode !== "source"
            ? livePreview(this.app, () => this.file?.path ?? "")
            : []
        ),
        autocompletion({ override: [wikilinkCompletion] }),
        placeholder("Start writing…"),
        EditorView.lineWrapping,
        Prec.high(
          keymap.of([
            {
              key: "Mod-b",
              run: (v) => (this.wrapSelection(v, "**"), true),
            },
            {
              key: "Mod-i",
              run: (v) => (this.wrapSelection(v, "*"), true),
            },
          ])
        ),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) this.scheduleSave();
        }),
        EditorView.domEventHandlers({
          mousedown(e, v) {
            if (!(e.metaKey || e.ctrlKey)) return false;
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos == null) return false;
            const link = view.wikilinkAt(v.state.doc.toString(), pos);
            if (link) {
              e.preventDefault();
              app.openLink(link, view.file?.path ?? "", false);
              return true;
            }
            return false;
          },
        }),
      ],
    });
    this.editor = new EditorView({ state, parent: this.editorHostEl });
  }

  private wikilinkAt(text: string, pos: number): string | null {
    const re = /\[\[([^\[\]\n]+)\]\]/g;
    for (const m of text.matchAll(re)) {
      if (pos >= m.index! && pos <= m.index! + m[0].length) {
        return m[1].split("|")[0].trim();
      }
    }
    return null;
  }

  private wrapSelection(v: EditorView, marker: string) {
    const { from, to } = v.state.selection.main;
    const selected = v.state.sliceDoc(from, to);
    v.dispatch({
      changes: { from, to, insert: `${marker}${selected}${marker}` },
      selection: { anchor: from + marker.length, head: to + marker.length },
    });
  }

  private scheduleSave() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 1000);
    this.app.statusBar.update();
  }

  /** Persist pending edits immediately. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.file || !this.editor) return;
    const text = this.editor.state.doc.toString();
    if (text === this.lastSavedText) return;
    this.lastSavedText = text;
    await this.app.vault.modify(this.file, text);
  }

  private async commitTitleRename() {
    const newName = this.titleEl.textContent?.trim();
    if (!this.file || !newName || newName === this.file.basename) return;
    if (/[\\/:#|^\[\]]/.test(newName)) {
      this.titleEl.textContent = this.file.basename;
      this.app.notify("Invalid characters in file name");
      return;
    }
    const newPath = (this.file.parent ? this.file.parent + "/" : "") + newName + "." + this.file.extension;
    await this.app.renameFileWithLinkUpdate(this.file, newPath);
  }

  getText(): string {
    return this.editor?.state.doc.toString() ?? this.lastSavedText;
  }

  /**
   * The text we last knew to be on disk for this file — set on load
   * (`setFile`) and after each successful autosave write (`flush`), BEFORE
   * the write's own `vault.modify()` event can echo back to us. Unlike
   * `getText()` (live, in-progress editor content, which is expected to
   * differ from disk between keystrokes), this is safe to compare against a
   * freshly-read disk value to detect genuine external changes. Mirrors
   * `BaseView`'s `lastKnownText` pattern (`base-view.ts`) — see its doc
   * comment for why content comparison, not live-state comparison, is
   * required here.
   */
  getLastKnownText(): string {
    return this.lastSavedText;
  }

  /** Cmd/Ctrl+E: flip between editing (live or source) and reading. */
  async toggleMode(): Promise<void> {
    this.mode = this.mode === "reading" ? this.lastEditingMode : "reading";
    if (this.mode === "reading") await this.renderReading();
    this.applyMode();
  }

  /** Flip between Live Preview and raw source while editing. */
  toggleSource(): void {
    if (this.mode === "reading") this.mode = this.lastEditingMode;
    this.mode = this.mode === "live" ? "source" : "live";
    this.lastEditingMode = this.mode;
    this.editor?.dispatch({
      effects: this.editingCompartment.reconfigure(
        this.mode === "live" ? livePreview(this.app, () => this.file?.path ?? "") : []
      ),
    });
    this.applyMode();
  }

  private applyMode() {
    const editing = this.mode !== "reading";
    this.editorHostEl.style.display = editing ? "" : "none";
    this.readingEl.style.display = editing ? "none" : "";
    if (editing) this.editor?.focus();
  }

  private async renderReading() {
    await this.flush();
    if (this.readingContentEl) this.app.markdownRenderer.dispose(this.readingContentEl);
    this.readingContentEl = null;
    this.readingEl.innerHTML = "";
    const inner = document.createElement("div");
    inner.className = "markdown-preview-sizer";
    this.readingEl.appendChild(inner);
    if (this.file) {
      const props = this.app.metadataCache.getFileCache(this.file)?.frontmatter;
      if (props && Object.keys(props).length) {
        inner.appendChild(renderProperties(props));
      }
    }
    const contentEl = document.createElement("div");
    this.readingContentEl = contentEl;
    inner.appendChild(contentEl);
    await this.app.markdownRenderer.render(this.getText(), contentEl, this.file?.path ?? "");
  }

  /** Jump the editor to a given offset (used by outline/search). */
  scrollToOffset(offset: number) {
    if (this.mode === "reading") {
      this.mode = this.lastEditingMode;
      this.applyMode();
    }
    if (!this.editor) return;
    const pos = Math.min(offset, this.editor.state.doc.length);
    this.editor.dispatch({
      selection: { anchor: pos },
      scrollIntoView: true,
    });
    this.editor.focus();
  }

  onOpen(): void {
    if (this.mode !== "reading") this.editor?.focus();
  }

  async onClose(): Promise<void> {
    await this.flush();
    this.editor?.destroy();
    this.editor = null;
    if (this.readingContentEl) this.app.markdownRenderer.dispose(this.readingContentEl);
    this.readingContentEl = null;
  }
}

/**
 * `.view-header-title-parent`'s children: one `.view-header-breadcrumb` per
 * folder path segment plus a literal (JS-inserted, not CSS `::after`)
 * `.view-header-breadcrumb-separator` between each — real Obsidian's app.css
 * has a dedicated rule for the separator element, confirming it isn't a
 * pseudo-element.
 */
function buildBreadcrumbs(parentPath: string): HTMLElement[] {
  const segments = parentPath.split("/").filter(Boolean);
  const out: HTMLElement[] = [];
  segments.forEach((segment, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "view-header-breadcrumb-separator";
      sep.textContent = "/";
      out.push(sep);
    }
    const crumb = document.createElement("span");
    crumb.className = "view-header-breadcrumb";
    crumb.textContent = segment;
    out.push(crumb);
  });
  return out;
}

function renderProperties(props: Record<string, unknown>): HTMLElement {
  const el = document.createElement("div");
  el.className = "metadata-container";
  const table = document.createElement("table");
  table.className = "metadata-table";
  for (const [key, value] of Object.entries(props)) {
    const row = document.createElement("tr");
    const k = document.createElement("td");
    k.className = "metadata-key";
    k.textContent = key;
    const v = document.createElement("td");
    v.className = "metadata-value";
    v.textContent = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    row.appendChild(k);
    row.appendChild(v);
    table.appendChild(row);
  }
  el.appendChild(table);
  return el;
}
