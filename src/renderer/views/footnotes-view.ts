import { ScopeCancelled } from "../workspaces/render-ownership";
import type { App } from "../app";
import type { TFile } from "../types";
import type { View } from "../workspace";
import { projectFootnotes, type FootnotePaneItem } from "../footnotes-pane";

export class FootnotesView implements View {
  readonly viewType = "footnotes";
  readonly containerEl = document.createElement("div");
  private readonly body = document.createElement("div");
  private readonly status = document.createElement("div");
  private readonly stops: (() => void)[] = [];
  private readonly root: string;
  private subject: TFile | null = null;
  private closed = false;
  private showing = false;
  private generation = 0;
  private navigationGeneration = 0;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly app: App) {
    this.root = app.vault.root;
    this.containerEl.className = "sidebar-view footnotes-view";
    const header = document.createElement("div"); header.className = "sidebar-view-header";
    const title = document.createElement("span"); title.className = "sidebar-view-title"; title.textContent = "Footnotes";
    header.appendChild(title);
    this.body.className = "sidebar-view-body";
    this.status.className = "pane-empty footnotes-status"; this.status.setAttribute("role", "status");
    this.containerEl.append(header, this.status, this.body);
    for (const name of ["file-open", "active-leaf-change", "layout-change"]) this.stops.push(app.workspace.on(name, () => this.sync()));
    for (const name of ["changed", "resolved"]) this.stops.push(app.metadataCache.on(name, () => this.schedule()));
    this.stops.push(app.workspace.on("editor-change", () => this.schedule(100)));
  }
  getDisplayText(): string { return "Footnotes"; }
  getIcon(): string { return "superscript"; }
  private get visible(): boolean {
    return !this.closed && this.containerEl.isConnected && !this.containerEl.closest(".sidebar-content > :not(.mod-active), .workspace-tab-container > .workspace-leaf:not(.mod-active)");
  }
  private cancel(): void { this.generation++; this.controller?.abort(); this.controller = null; clearTimeout(this.timer); }
  private schedule(delay = 0): void {
    this.cancel(); if (!this.visible) return;
    this.status.textContent = "Refreshing footnotes…";
    this.timer = setTimeout(() => { void this.render(); }, delay);
  }
  private sync(force = false): void {
    if (this.closed) return;
    const next = this.app.workspace.getActiveFile();
    const changed = next !== this.subject, visible = this.visible, revealed = visible && !this.showing;
    this.showing = visible;
    if (!visible) this.cancel();
    if (changed) { this.cancel(); this.subject = next; this.body.replaceChildren(); this.status.textContent = ""; }
    if (visible && (force || changed || revealed)) void this.render();
  }
  onOpen(): void { this.sync(true); }
  onReveal(): void { this.sync(true); }
  onClose(): void { this.navigationGeneration++; this.closed = true; this.cancel(); for (const stop of this.stops.splice(0)) stop(); }

  async render(): Promise<void> {
    this.cancel(); if (!this.visible || this.app.vault.root !== this.root) return;
    const controller = new AbortController(); this.controller = controller;
    const generation = this.generation, file = this.subject;
    const current = () => !controller.signal.aborted && generation === this.generation && file === this.subject && this.visible && this.app.vault.root === this.root;
    if (!file || file.extension !== "md") { this.body.replaceChildren(); this.status.textContent = "No file is open."; return; }
    this.status.textContent = "Loading footnotes…";
    try {
      const view = this.app.getActiveMarkdownView();
      const snapshot = view?.file === file ? view.getText() : await this.app.vault.read(file);
      if (!current()) return;
      const projection = await projectFootnotes(snapshot, { signal: controller.signal });
      if (!current()) return;
      this.body.replaceChildren();
      if (!projection.items.length) {
        const empty = document.createElement("div"); empty.className = "pane-empty"; empty.textContent = "No footnotes found."; this.body.appendChild(empty);
      }
      const editable = view?.file === file && !!view.editor && !view.isConflictReadOnly();
      for (const item of projection.items) {
        const row = document.createElement("div"); row.className = "footnotes-item";
        const edit = document.createElement("button"); edit.type = "button"; edit.className = "footnotes-edit";
        edit.setAttribute("aria-label", `Edit footnote ${item.label}`);
        edit.disabled = !editable || !item.editable;
        const label = document.createElement("span"); label.className = "footnotes-label"; label.textContent = item.label;
        const text = document.createElement("span"); text.className = "footnotes-text"; text.textContent = item.text || "Empty footnote";
        edit.append(label, text);
        edit.addEventListener("click", () => { void this.navigate(file, snapshot, item, true); });
        const detail = document.createElement("div"); detail.className = "footnotes-detail";
        detail.textContent = item.missing ? item.text : `${item.references} reference${item.references === 1 ? "" : "s"}${item.editable ? "" : " · Partial definition; navigate to edit"}`;
        const jump = document.createElement("button"); jump.type = "button"; jump.className = "footnotes-jump"; jump.textContent = "Jump";
        jump.setAttribute("aria-label", `Go to footnote ${item.label}`);
        jump.addEventListener("click", () => { void this.navigate(file, snapshot, item, false); });
        row.append(edit, detail, jump); this.body.appendChild(row);
      }
      const notices: string[] = [];
      if (projection.limited) notices.push(`Showing ${projection.items.length} footnotes from a limited scan (first ${projection.scannedCharacters.toLocaleString()} characters; up to 200 rows).`);
      if (!editable && projection.items.length) notices.push("Open this note in an editable Markdown view to edit footnotes.");
      this.status.textContent = notices.join(" ");
    } catch { if (current()) this.status.textContent = "Could not load footnotes. Reopen the pane to retry."; }
  }
  private async navigate(file: TFile, snapshot: string, item: FootnotePaneItem, edit: boolean): Promise<void> {
    const view = this.app.getActiveMarkdownView(), editor = view?.editor;
    const vault = this.app.vault, root = vault.root, path = file.path;
    const leaf = this.app.workspace.getActiveLeaf(), navigation = ++this.navigationGeneration;
    const current = () => navigation === this.navigationGeneration && this.visible && this.root === root &&
      this.app.vault === vault && vault.root === root && file.path === path && vault.getFileByPath(path) === file &&
      this.app.workspace.getActiveLeaf() === leaf && this.app.workspace.getActiveFile() === file &&
      this.app.getActiveMarkdownView() === view && view?.file === file && view.editor === editor && view.getText() === snapshot &&
      (!edit || (item.editable && view.canApplySourceEdit({ allowReading: true })));
    if (!view || !editor || !current()) { this.schedule(); return; }
    const from = edit ? item.editFrom : item.from, to = edit ? item.editTo : item.from;
    try {
      await view.scrollToOffsetAsync(from, { focus: false });
      if (!current()) { this.schedule(); return; }
      if (edit && view.mode !== "source") {
        await view.toggleSource({ focus: false });
        if (!current()) { this.schedule(); return; }
      }
      editor.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
      if (current()) editor.focus();
    } catch (error) {
      if (!(error instanceof ScopeCancelled) && current()) {
        this.status.textContent = `Could not open footnote: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
}
