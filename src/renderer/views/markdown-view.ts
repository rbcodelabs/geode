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
import type { App, ContextMenuItemSpec } from "../app";
import { buildViewHeaderNavButtons, type View } from "../workspace";
import { setIcon } from "../api/icons";
import type { HeadingCache, TFile } from "../types";
import { frontmatterEndOffset, livePreview } from "../markdown/live-preview";
import { resolveBlockBoundary } from "../block-boundary";
import { PagePreviewController } from "../page-preview";
import { commentDecorations, commentInteractions } from "../comments/editor-extension";
import { CommentFormatError, narrowCommentRange, parseCommentThreads, validateCommentRange } from "../comments/model";
import { geodeCommentMarkerSyntax } from "../comments/marker-syntax";

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
  private lineEnding: "\n" | "\r\n" = "\n";
  private pendingSaveText: string | null = null;
  private flushInFlight: Promise<void> | null = null;
  private vaultSwitching = false;
  private conflictReadOnly = false;
  private conflictBanner: HTMLElement | null = null;
  private pagePreview: PagePreviewController;
  private commentButton: HTMLButtonElement;

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
    this.titleEl.setAttribute("role", "textbox");
    this.titleEl.setAttribute("aria-label", "Note title");
    this.titleEl.setAttribute("aria-multiline", "false");
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
    sourceBtn.addEventListener("click", () => void this.app.actions.execute("view.toggle-source", { view: this }));
    const modeBtn = document.createElement("button");
    modeBtn.className = "view-mode-toggle clickable-icon view-action";
    modeBtn.title = "Toggle reading view (Cmd/Ctrl+E)";
    modeBtn.setAttribute("aria-label", "Toggle reading view (Cmd/Ctrl+E)");
    setIcon(modeBtn, "book-open");
    modeBtn.addEventListener("click", () => void this.app.actions.execute("view.toggle-reading", { view: this }));
    const moreBtn = document.createElement("button");
    moreBtn.className = "view-more-options clickable-icon view-action";
    moreBtn.title = "More options";
    moreBtn.setAttribute("aria-label", "More options");
    setIcon(moreBtn, "more-vertical");
    moreBtn.addEventListener("click", (event) => {
      const leaf = this.app.workspace.findLeafForView(this);
      if (leaf) this.app.showDocumentMenu(event, leaf, { anchor: moreBtn });
    });
    actions.append(sourceBtn, modeBtn, moreBtn);

    this.headerEl.append(left, titleContainer, actions);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "markdown-view-body";
    this.editorHostEl = document.createElement("div");
    this.editorHostEl.className = "markdown-source-view";
    this.commentButton = document.createElement("button");
    this.commentButton.type = "button";
    this.commentButton.className = "comment-selection-button";
    this.commentButton.textContent = "Comment";
    this.commentButton.hidden = true;
    this.commentButton.addEventListener("click", () => this.app.promptCommentForSelection(this));
    this.editorHostEl.appendChild(this.commentButton);
    this.readingEl = document.createElement("div");
    this.readingEl.className = "markdown-reading-view markdown-rendered";
    this.bodyEl.appendChild(this.editorHostEl);
    this.bodyEl.appendChild(this.readingEl);
    this.containerEl.appendChild(this.headerEl);
    this.containerEl.appendChild(this.bodyEl);
    this.pagePreview = new PagePreviewController(
      this.app,
      this.containerEl,
      () => this.file?.path ?? ""
    );
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
    this.pagePreview.hide();
    await this.flush();
    const diskText = await this.app.vault.read(file);
    this.lineEnding = diskText.includes("\r\n") ? "\r\n" : "\n";
    const text = diskText.replace(/\r\n/g, "\n");
    this.file = file;
    this.titleEl.textContent = file.basename;
    this.titleParentEl.innerHTML = "";
    if (file.parent) {
      for (const el of buildBreadcrumbs(file.parent)) this.titleParentEl.appendChild(el);
    }
    this.clearConflictState();
    this.lastSavedText = text;
    this.buildEditor(text);
    if (this.mode === "reading") await this.renderReading();
    this.applyMode(!document.body.classList.contains("is-mobile"));
  }

  /** Enter the same title-editing flow used after creating an Untitled note. */
  beginTitleRename(): void {
    this.titleEl.focus();
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(this.titleEl);
    selection.addRange(range);
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
        // `geodeCommentMarkerSyntax` keeps a marker sitting on a line's first
        // content position from starting a CommonMark HTML block and swallowing
        // the rest of the line — see the note in `comments/marker-syntax.ts`.
        markdown({ base: markdownLanguage, extensions: [geodeCommentMarkerSyntax] }),
        syntaxHighlighting(mdHighlight),
        this.editingCompartment.of(
          this.mode !== "source"
            ? [livePreview(this.app, () => this.file?.path ?? ""), commentDecorations, commentInteractions((id) => this.app.selectComment(id))]
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
          if (update.docChanged || update.selectionSet) this.updateCommentButton();
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
          contextmenu(e, v) {
            const file = view.file;
            if (!file) return false;
            const items: ContextMenuItemSpec[] = [];
            const selection = v.state.selection.main;
            let hasComment = false;
            if (selection.from !== selection.to) {
              try {
                validateCommentRange(v.state.doc.toString(), selection);
                items.push({ title: "Add comment", icon: "message-square", action: () => app.promptCommentForSelection(view) });
                hasComment = true;
              } catch { /* fall through to heading actions */ }
            }
            if (!hasComment) {
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos != null) {
                const line = v.state.doc.lineAt(pos).number - 1; // 0-based
                const heading = view.headingAtLine(line);
                if (heading) {
                  items.push({
                    title: "Bookmark this heading",
                    icon: "bookmark",
                    action: () => void app.addHeadingBookmark(file, heading),
                  });
                }
              }
            }
            // Always fire `editor-menu` so plugins can contribute even when
            // neither built-in above applies — matches Obsidian firing it on
            // every editor right-click, not just Geode's special-cased ones.
            // `v` (CodeMirror's EditorView) stands in for Obsidian's richer
            // `Editor` wrapper, which Geode doesn't implement yet; plugins
            // that only read `info.file` (the common case) are unaffected.
            const menu = app.buildMenu(items);
            app.workspace.trigger("editor-menu", menu, v, view);
            if (menu.items.length === 0) return false;
            e.preventDefault();
            menu.showAtMouseEvent(e);
            return true;
          },
        }),
      ],
    });
    this.editor = new EditorView({ state, parent: this.editorHostEl });
    this.editor.contentDOM.setAttribute("role", "textbox");
    this.editor.contentDOM.setAttribute("aria-label", "Note editor");
    this.editor.contentDOM.setAttribute("aria-multiline", "true");
  }

  private updateCommentButton(): void {
    if (!this.editor || this.mode !== "live") { this.commentButton.hidden = true; return; }
    const selection = this.editor.state.selection.main;
    try {
      // Narrowed rather than validated: a selection dragged across a heading's
      // `#` or a list bullet still offers the button, anchored to the prose.
      if (!narrowCommentRange(this.editor.state.doc.toString(), selection)) throw new Error("No commentable range");
      const coords = this.editor.coordsAtPos(selection.to);
      if (!coords) throw new Error("Selection is not visible");
      const host = this.editorHostEl.getBoundingClientRect();
      this.commentButton.style.left = `${Math.min(host.width - 90, Math.max(8, coords.left - host.left))}px`;
      this.commentButton.style.top = `${Math.max(8, coords.bottom - host.top + 4)}px`;
      this.commentButton.hidden = false;
    } catch { this.commentButton.hidden = true; }
  }

  async applyCommentMutation(mutator: (source: string) => string): Promise<void> {
    if (!this.editor) throw new Error("The note editor is not available");
    const source = this.editor.state.doc.toString();
    const next = mutator(source);
    if (next === source) return;
    this.editor.dispatch({ changes: { from: 0, to: source.length, insert: next } });
    await this.flush();
  }

  getSelectedRange(): { from: number; to: number } | null {
    if (!this.editor || this.mode === "reading") return null;
    const { from, to } = this.editor.state.selection.main;
    return narrowCommentRange(this.editor.state.doc.toString(), { from, to });
  }

  /**
   * Why the current selection cannot be commented, for the command's toast.
   * `narrowCommentRange` deliberately reports only success or failure, so the
   * precise reason is recovered by re-running the validator that produced it.
   */
  describeCommentRangeRejection(): string | null {
    if (!this.editor || this.mode === "reading") return "Open a note in edit mode to add a comment";
    const { from, to } = this.editor.state.selection.main;
    try {
      validateCommentRange(this.editor.state.doc.toString(), { from, to });
      return null;
    } catch (error) {
      return error instanceof CommentFormatError ? error.message : null;
    }
  }

  revealComment(threadId: string): void {
    const thread = parseCommentThreads(this.getText()).threads.find((item) => item.id === threadId);
    if (!thread) return;
    if (this.mode !== "live") {
      this.mode = "live";
      this.lastEditingMode = "live";
      this.editor?.dispatch({ effects: this.editingCompartment.reconfigure([
        livePreview(this.app, () => this.file?.path ?? ""),
        commentDecorations,
        commentInteractions((id) => this.app.selectComment(id)),
      ]) });
      this.applyMode();
    }
    this.editor?.dispatch({ selection: { anchor: thread.from, head: thread.to }, scrollIntoView: true });
    this.editor?.focus();
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
    if (this.vaultSwitching || this.conflictReadOnly) return;
    this.saveTimer = window.setTimeout(() => this.flush(), 1000);
    this.app.statusBar.update();
  }

  /** Persist pending edits immediately. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.flushInFlight) await this.flushInFlight;
    if (!this.file || !this.editor) return;
    const text = this.editor.state.doc.toString();
    if (text === this.lastSavedText) return;
    const file = this.file;
    this.pendingSaveText = text;
    const persistedText = this.serializeText(text);
    const write = this.app.vault.modify(file, persistedText);
    this.flushInFlight = write;
    try {
      await write;
      this.lastSavedText = text;
    } finally {
      if (this.pendingSaveText === text) this.pendingSaveText = null;
      if (this.flushInFlight === write) this.flushInFlight = null;
    }
  }

  async prepareVaultSwitch(): Promise<void> {
    this.vaultSwitching = true;
    await this.flush();
  }

  cancelVaultSwitch(): void {
    this.vaultSwitching = false;
    if (this.editor && this.editor.state.doc.toString() !== this.lastSavedText) this.scheduleSave();
  }

  async pauseAutosave(): Promise<void> {
    this.vaultSwitching = true;
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.flushInFlight) await this.flushInFlight;
  }

  resumeAutosave(): void {
    this.vaultSwitching = false;
    if (!this.conflictReadOnly && this.hasUnacknowledgedChanges()) this.scheduleSave();
  }

  hasUnacknowledgedChanges(): boolean {
    return this.pendingSaveText !== null || this.getText() !== this.lastSavedText;
  }

  acceptExternalText(text: string): void {
    this.pagePreview.hide();
    this.clearConflictState();
    this.pendingSaveText = null;
    this.lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
    const normalized = text.replace(/\r\n/g, "\n");
    this.lastSavedText = normalized;
    this.buildEditor(normalized);
    if (this.mode === "reading") void this.renderReading();
    this.applyMode();
  }

  presentConflict(
    externalText: string | null,
    conflictPath: string | null,
    recoveryOnly: boolean,
    recoveryLocation: "device" | "memory" = "device",
  ): void {
    const localText = this.getText();
    this.conflictReadOnly = true;
    this.lastSavedText = externalText ?? "";
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.editor?.contentDOM.setAttribute("contenteditable", "false");
    this.editor?.contentDOM.setAttribute("aria-readonly", "true");
    this.conflictBanner?.remove();
    const banner = document.createElement("div");
    banner.className = "editor-conflict-banner";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-label", "External edit conflict");
    const message = document.createElement("span");
    message.textContent = recoveryOnly
      ? recoveryLocation === "device"
        ? "External changes were found. Your local edit is in device recovery storage; the provider note is read-only."
        : "External changes were found. Your local edit is held in memory only; keep Geode open and retry before leaving this note."
      : externalText === null
        ? `The provider note was deleted or moved. Your local edit was preserved as ${conflictPath}.`
      : `External changes were found. Your local edit was preserved as ${conflictPath}.`;
    banner.appendChild(message);
    if (externalText !== null) {
      const openProvider = document.createElement("button");
      openProvider.type = "button";
      openProvider.textContent = "Open provider version";
      openProvider.addEventListener("click", () => this.acceptExternalText(externalText));
      banner.appendChild(openProvider);
    }
    if (conflictPath) {
      const openConflict = document.createElement("button");
      openConflict.type = "button";
      openConflict.textContent = "Open conflict copy";
      openConflict.addEventListener("click", () => {
        const file = this.app.vault.getFileByPath(conflictPath);
        if (file) void this.app.openFile(file, true);
      });
      banner.appendChild(openConflict);
    }
    const copyLocal = document.createElement("button");
    copyLocal.type = "button";
    copyLocal.textContent = "Copy local version";
    copyLocal.addEventListener("click", () => void navigator.clipboard?.writeText(localText));
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => banner.remove());
    banner.appendChild(copyLocal);
    if (externalText !== null) {
      const copyProvider = document.createElement("button");
      copyProvider.type = "button";
      copyProvider.textContent = "Copy provider version";
      copyProvider.addEventListener("click", () => void navigator.clipboard?.writeText(externalText));
      banner.appendChild(copyProvider);
    }
    banner.appendChild(dismiss);
    this.containerEl.prepend(banner);
    this.conflictBanner = banner;
  }

  restoreConflictRecovery(localText: string, externalText: string | null): void {
    this.lastSavedText = externalText ?? "";
    this.buildEditor(localText);
    this.presentConflict(externalText, null, true);
    this.applyMode();
  }

  private clearConflictState(): void {
    this.conflictReadOnly = false;
    this.conflictBanner?.remove();
    this.conflictBanner = null;
    this.editor?.contentDOM.removeAttribute("aria-readonly");
  }

  private async commitTitleRename() {
    const newName = this.titleEl.textContent?.trim() ?? "";
    if (!this.file) return;
    if (newName === this.file.basename) {
      this.titleEl.textContent = this.file.basename;
      return;
    }
    const oldName = this.file.basename;
    if (!(await this.app.renameFile(this.file, newName))) this.titleEl.textContent = oldName;
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
    return this.serializeText(this.pendingSaveText ?? this.lastSavedText);
  }

  private serializeText(text: string): string {
    return this.lineEnding === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
  }

  /** Cmd/Ctrl+E: flip between editing (live or source) and reading. */
  async toggleMode(): Promise<void> {
    this.pagePreview.hide();
    this.mode = this.mode === "reading" ? this.lastEditingMode : "reading";
    if (this.mode === "reading") await this.renderReading();
    this.applyMode();
  }

  /** Flip between Live Preview and raw source while editing. */
  toggleSource(): void {
    this.pagePreview.hide();
    if (this.mode === "reading") this.mode = this.lastEditingMode;
    this.mode = this.mode === "live" ? "source" : "live";
    this.lastEditingMode = this.mode;
    this.editor?.dispatch({
      effects: this.editingCompartment.reconfigure(
        this.mode === "live" ? [livePreview(this.app, () => this.file?.path ?? ""), commentDecorations, commentInteractions((id) => this.app.selectComment(id))] : []
      ),
    });
    this.applyMode();
  }

  private applyMode(focusEditor = true) {
    const editing = this.mode !== "reading";
    this.editorHostEl.style.display = editing ? "" : "none";
    this.readingEl.style.display = editing ? "none" : "";
    if (editing && focusEditor) this.editor?.focus();
  }

  private async renderReading() {
    this.pagePreview.hide();
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

  // --- Bookmarks (headings & blocks) --------------------------------------

  /**
   * The nearest heading at or above `line` (0-based) — the last `HeadingCache`
   * whose start line is `<= line`. Headings are cache-ordered by position, so
   * a single forward scan suffices.
   */
  headingAtLine(line: number): HeadingCache | null {
    if (!this.file) return null;
    const headings = this.app.metadataCache.getFileCache(this.file)?.headings ?? [];
    let best: HeadingCache | null = null;
    for (const h of headings) {
      if (h.position.start.line <= line) best = h;
      else break;
    }
    return best;
  }

  /** Command entry: bookmark the heading the cursor is under (spec: "Bookmark heading under cursor"). */
  bookmarkHeadingUnderCursor(): void {
    if (!this.file || !this.editor) {
      this.app.notify("Open a note to bookmark a heading");
      return;
    }
    const line = this.editor.state.doc.lineAt(this.editor.state.selection.main.head).number - 1;
    const heading = this.headingAtLine(line);
    if (!heading) {
      this.app.notify("No heading found above the cursor");
      return;
    }
    void this.app.addHeadingBookmark(this.file, heading);
  }

  /**
   * Command entry: bookmark the block the cursor is in (spec: "Bookmark block
   * under cursor"). Reuses an existing trailing `^id` on the block's last line,
   * or generates a short one and appends it to that line (persisting the file),
   * then stores a block bookmark.
   */
  async bookmarkBlockUnderCursor(): Promise<void> {
    if (!this.file || !this.editor) {
      this.app.notify("Open a note to bookmark a block");
      return;
    }
    const doc = this.editor.state.doc;
    const cursorLine0 = doc.lineAt(this.editor.state.selection.main.head).number - 1;
    const cache = this.app.metadataCache.getFileCache(this.file);
    const boundary = resolveBlockBoundary(cursorLine0, cache?.sections ?? [], cache?.listItems ?? []);
    if (boundary.kind === "refuse") {
      this.app.notify(boundary.reason);
      return;
    }
    const cmLine = doc.line(boundary.line + 1);
    const text = cmLine.text;
    const existing = text.match(/(?:^|[ \t])\^([A-Za-z0-9-]+)\s*$/);
    let blockId: string;
    if (existing) {
      blockId = existing[1];
    } else {
      blockId = crypto.randomUUID().slice(0, 6);
      // Always emit a leading space before `^id`: the metadata parser's
      // BLOCK_ID_RE requires a preceding space/tab, so `^id` written at column 0
      // (on an empty line) would never be indexed as a block reference.
      const prefix = /\s$/.test(text) ? "" : " ";
      this.editor.dispatch({ changes: { from: cmLine.to, insert: `${prefix}^${blockId}` } });
      await this.flush();
    }
    await this.app.addBlockBookmark(this.file, blockId);
  }

  onOpen(): void {
    if (this.mode !== "reading" && !document.body.classList.contains("is-mobile")) this.editor?.focus();
  }

  async onClose(): Promise<void> {
    this.pagePreview.destroy();
    await this.flush();
    this.vaultSwitching = true;
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
