import type { App } from "../app";
import type { View } from "../workspace";
import type { TFile } from "../types";
import { findOutgoingMentions, mentionStillCurrent, outgoingReferences, type OutgoingMention, type OutgoingTarget } from "../outgoing-links";

/** Source-local sidebar: one live note, target names/aliases, no target-body reads. */
export class OutgoingLinksView implements View {
  readonly viewType = "outgoing-links";
  readonly containerEl = document.createElement("div");
  private readonly bodyEl = document.createElement("div");
  private readonly statusEl = document.createElement("div");
  private subject: TFile | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private showing = false;
  private readonly root: string;
  private readonly stops: (() => void)[] = [];

  constructor(private readonly app: App) {
    this.root = app.vault.root;
    this.containerEl.className = "sidebar-view outgoing-links-view";
    const header = document.createElement("div"); header.className = "sidebar-view-header";
    const title = document.createElement("span"); title.className = "sidebar-view-title"; title.textContent = "Outgoing links";
    header.appendChild(title);
    this.bodyEl.className = "sidebar-view-body";
    this.statusEl.className = "outgoing-links-status pane-empty"; this.statusEl.setAttribute("role", "status");
    this.containerEl.append(header, this.statusEl, this.bodyEl);
    for (const event of ["file-open", "active-leaf-change", "layout-change"]) this.stops.push(app.workspace.on(event, () => this.syncSubject()));
    for (const event of ["changed", "resolved"]) this.stops.push(app.metadataCache.on(event, () => this.schedule()));
    this.stops.push(app.workspace.on("editor-change", () => this.schedule(120)));
    this.stops.push(app.excludedFiles.onChange(() => this.schedule()));
    // Attach a rejection handler immediately; render still displays the load error.
    void app.excludedFiles.ready.catch(() => this.schedule());
  }
  getDisplayText(): string { return "Outgoing links"; }
  getIcon(): string { return "arrow-up-right"; }
  private get visible(): boolean {
    return !this.closed && this.containerEl.isConnected && !this.containerEl.closest(".sidebar-content > :not(.mod-active), .workspace-tab-container > .workspace-leaf:not(.mod-active)");
  }
  private cancel(): void { this.generation++; this.controller?.abort(); this.controller = null; clearTimeout(this.timer); this.timer = undefined; }
  private syncSubject(force = false): void {
    if (this.closed) return;
    const next = this.app.workspace.getActiveFile();
    const changed = next !== this.subject;
    const visible = this.visible;
    const revealed = visible && !this.showing;
    this.showing = visible;
    if (!visible) this.cancel();
    if (changed) { this.cancel(); this.subject = next; this.bodyEl.replaceChildren(); this.statusEl.textContent = ""; }
    if (visible && (force || changed || revealed)) void this.render();
  }
  private schedule(delay = 0): void {
    this.cancel();
    if (!this.visible) return;
    this.statusEl.textContent = "Refreshing outgoing links…";
    this.timer = setTimeout(() => { this.timer = undefined; void this.render(); }, delay);
  }
  onOpen(): void { this.syncSubject(true); }
  onReveal(): void { this.syncSubject(true); }
  onClose(): void { this.closed = true; this.cancel(); for (const stop of this.stops.splice(0)) stop(); }

  async render(): Promise<void> {
    this.cancel();
    if (!this.visible || this.app.vault.root !== this.root) return;
    const controller = new AbortController(); this.controller = controller;
    const generation = this.generation, file = this.subject;
    const current = () => !controller.signal.aborted && !this.closed && this.visible && generation === this.generation && this.subject === file && this.app.vault.root === this.root;
    if (!file || file.extension !== "md") { this.bodyEl.replaceChildren(); this.statusEl.textContent = "No file is open."; return; }
    this.statusEl.textContent = "Loading outgoing links…";
    this.bodyEl.setAttribute("aria-busy", "true");
    try {
      await this.app.excludedFiles.ready;
      if (!current()) return;
      const editor = this.app.getActiveMarkdownView();
      const snapshot = editor?.file === file ? editor.getText() : await this.app.vault.read(file);
      if (!current()) return;
      // The matcher yields while walking large vaults; target metadata itself is never
      // read from disk. Generate candidates lazily to avoid an uninterrupted full copy.
      const app = this.app;
      function* targets(): IterableIterator<OutgoingTarget> {
        for (const target of app.vault.getMarkdownFiles()) yield { path: target.path, basename: target.basename, aliases: app.metadataCache.getFileCache(target)?.aliases ?? [] };
      }
      const scan = await findOutgoingMentions(snapshot, file.path, targets(), { signal: controller.signal, excluded: this.app.excludedFiles.matches });
      if (!current()) return;
      const mentions = scan.mentions;
      this.bodyEl.replaceChildren();
      const references = outgoingReferences(snapshot);
      this.section(`Links (${references.reduce((count, reference) => count + reference.count, 0)})`);
      if (!references.length) this.message("No outgoing links found.");
      for (const reference of references) {
        const target = this.app.metadataCache.getFirstLinkpathDest(reference.link, file.path);
        const row = document.createElement("button"); row.type = "button"; row.className = "pane-result nav-item outgoing-link-target";
        row.title = target?.path ?? reference.link;
        row.setAttribute("aria-label", `${reference.displayText} — ${target?.path ?? "Unresolved: " + reference.link}`);
        const title = document.createElement("span"); title.className = "nav-item-title"; title.textContent = reference.displayText;
        const count = document.createElement("span"); count.className = "pane-result-count"; count.textContent = String(reference.count);
        row.append(title, count);
        row.addEventListener("click", event => { void this.app.workspace.openLinkText(reference.link, file.path, event.metaKey || event.ctrlKey).catch(() => this.app.notify("Could not open link")); });
        this.bodyEl.appendChild(row);
      }
      this.section(`Unlinked mentions (${mentions.length})`);
      if (!mentions.length) this.message("No unlinked mentions found.");
      const editable = editor?.file === file && editor.canApplySourceEdit();
      for (const mention of mentions) {
        const row = document.createElement("div"); row.className = "outgoing-mention";
        const snippet = document.createElement("div"); snippet.className = "pane-result-context"; snippet.textContent = mention.snippet;
        const path = document.createElement("div"); path.className = "outgoing-mention-path"; path.textContent = mention.targetPath;
        const button = document.createElement("button"); button.type = "button"; button.className = "outgoing-link-convert"; button.textContent = "Link";
        button.title = mention.targetPath; button.disabled = !editable;
        button.setAttribute("aria-label", `Link ${mention.text} to ${mention.targetPath}`);
        button.addEventListener("click", () => this.convert(file, snapshot, mention));
        row.append(snippet, path, button); this.bodyEl.appendChild(row);
      }
      const notices: string[] = [];
      if (scan.limited) notices.push(`Showing ${mentions.length} suggestions from a limited scan (first ${scan.scannedCharacters.toLocaleString()} characters; up to 500 matches).`);
      if (!editable && mentions.length) notices.push("Open this note in edit mode to link mentions.");
      this.statusEl.textContent = notices.join(" ");
    } catch (error) {
      if (current()) this.statusEl.textContent = "Could not load outgoing links. Reopen this pane to retry.";
    } finally { if (current()) this.bodyEl.removeAttribute("aria-busy"); }
  }
  private convert(file: TFile, snapshot: string, mention: OutgoingMention): void {
    const editor = this.app.getActiveMarkdownView();
    const target = this.app.vault.getFileByPath(mention.targetPath);
    if (!this.visible || this.app.vault.root !== this.root || this.app.workspace.getActiveFile() !== file || editor?.file !== file || !target || this.app.vault.getFileByPath(file.path) !== file ||
      !mentionStillCurrent(snapshot, editor.getText(), mention) || !editor.canApplySourceEdit()) { this.schedule(); return; }
    const link = this.app.fileManager.generateMarkdownLink(target, file.path, "", mention.text);
    const generated = outgoingReferences(link);
    if (generated.length !== 1 || generated[0].displayText !== mention.text ||
        this.app.metadataCache.getFirstLinkpathDest(generated[0].link, file.path) !== target) {
      this.app.notify("Could not create an unambiguous link for this mention.");
      this.schedule(); return;
    }
    if (!editor.applySourceEdit(snapshot, mention.from, mention.to, link)) { this.schedule(); return; }
    this.schedule();
  }
  private section(text: string): void { const element = document.createElement("div"); element.className = "pane-section-header"; element.textContent = text; this.bodyEl.appendChild(element); }
  private message(text: string): void { const element = document.createElement("div"); element.className = "pane-empty"; element.textContent = text; this.bodyEl.appendChild(element); }
}
