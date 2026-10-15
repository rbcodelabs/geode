import type { App } from "../app";
import type { View } from "../workspace";
import type { MarkdownView } from "./markdown-view";
import type { TFile } from "../types";
import { PropertyEditor } from "../properties/property-editor";
import { mutateProperty, type PropertyMutation } from "../properties/property-source";

/** File properties always follow the centre note and mutate its owned buffer. */
export class FilePropertiesView implements View {
  readonly viewType = "file-properties";
  readonly containerEl = document.createElement("div");
  private readonly body = document.createElement("div");
  private subject: TFile | null = null;
  private owner: MarkdownView | null = null;
  private controls: PropertyEditor | null = null;
  private closed = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly root: string;
  private readonly stops: (() => void)[] = [];
  constructor(private readonly app: App) {
    this.root = app.vault.root;
    this.containerEl.className = "sidebar-view file-properties-view";
    const header = document.createElement("div"); header.className = "sidebar-view-header";
    const title = document.createElement("span"); title.className = "sidebar-view-title"; title.textContent = "File properties";
    header.append(title); this.body.className = "sidebar-view-body"; this.containerEl.append(header, this.body);
    for (const event of ["file-open", "active-leaf-change", "layout-change"]) this.stops.push(app.workspace.on(event, () => this.refresh()));
    this.stops.push(app.workspace.on("editor-change", owner => {
      if (owner?.file !== this.subject || !this.visible) return;
      clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = undefined; this.refresh(); }, 40);
    }));
    this.stops.push(app.metadataCache.on("changed", file => { if (file === this.subject) this.refresh(); }));
    for (const event of ["delete", "rename", "modify"]) this.stops.push(app.vault.on(event, () => this.refresh()));
  }
  getDisplayText(): string { return "File properties"; }
  getIcon(): string { return "list"; }
  private get visible(): boolean {
    return !this.closed && this.containerEl.isConnected && !this.containerEl.closest(".sidebar-content > :not(.mod-active), .workspace-tab-container > .workspace-leaf:not(.mod-active)");
  }
  onOpen(): void { this.refresh(); }
  onReveal(): void { this.refresh(); }
  onClose(): void { clearTimeout(this.timer); this.closed = true; this.generation++; this.controls = null; for (const stop of this.stops.splice(0)) stop(); }
  refresh(): void {
    if (!this.visible || this.app.vault.root !== this.root) return;
    const file = this.app.workspace.getActiveFile();
    const owner = this.app.getActiveMarkdownView();
    if (file && file.extension === "md" && owner?.file === file && this.subject === file && this.owner === owner && this.controls) { this.controls.refresh(); return; }
    this.generation++; this.subject = file; this.owner = owner; this.controls = null; this.body.replaceChildren();
    if (!file || file.extension !== "md") { this.body.textContent = "No file is open."; return; }
    const name = document.createElement("div"); name.className = "file-properties-name"; name.textContent = file.basename; this.body.append(name);
    if (owner?.file === file) {
      const generation = this.generation;
      const owns = () => this.current(file) && this.generation === generation && this.owner === owner && this.app.getActiveMarkdownView() === owner && owner.file === file;
      this.controls = new PropertyEditor({
        getText: () => owns() ? owner.getText() : "",
        editable: () => owns() && owner.canApplySourceEdit({ allowReading: true }),
        commit: operation => owns() ? this.commit(file, owner, operation) : { ok: false, error: "The active note changed. Refresh the field before editing." },
        openSource: () => { if (owns()) { if (owner.mode !== "source") void this.app.actions.execute("view.toggle-source", { view: owner }); else owner.editor?.focus(); } },
      });
      this.body.append(this.controls.root);
    } else {
      const message = document.createElement("div"); message.className = "pane-empty"; message.textContent = "Open this note to edit its properties.";
      const open = document.createElement("button"); open.type = "button"; open.textContent = "Open note"; open.addEventListener("click", () => { if (this.current(file)) void this.app.openFile(file, false); });
      this.body.append(message, open);
      const generation = this.generation;
      void this.app.vault.read(file).then(snapshot => {
        if (!this.current(file) || !this.visible || generation !== this.generation) return;
        this.controls = new PropertyEditor({ getText: () => snapshot, editable: () => false, commit: () => ({ ok: false, error: "Open this note to edit it." }), openSource: () => { if (this.current(file)) void this.app.openFile(file, false); } });
        this.body.append(this.controls.root);
      }).catch(() => { if (this.current(file) && generation === this.generation) message.textContent = "Could not read this note. Open it to try again."; });
    }
  }
  private current(file: TFile): boolean {
    return !this.closed && this.app.vault.root === this.root && this.subject === file && this.app.workspace.getActiveFile() === file && this.app.vault.getFileByPath(file.path) === file;
  }
  private commit(file: TFile, owner: MarkdownView, operation: PropertyMutation): { ok: true } | { ok: false; error: string } {
    if (!this.current(file) || this.app.getActiveMarkdownView() !== owner || owner.file !== file || !owner.canApplySourceEdit({ allowReading: true })) return { ok: false, error: "The active note changed or is read-only. Refresh the field before editing." };
    const snapshot = owner.getText();
    const result = mutateProperty(snapshot, operation);
    if (!result.ok) return result;
    return owner.applySourceEdit(snapshot, result.from, result.to, result.insert, { allowReading: true }) ? { ok: true } : { ok: false, error: "The note changed before the edit could be applied." };
  }
}
