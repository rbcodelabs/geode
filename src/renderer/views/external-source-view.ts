import type { App } from "../app";
import type { View, WorkspaceLeaf } from "../workspace";
import { normalizeResourceRelativePath, type ResourceRef } from "../../shared/root-registry";

export interface ExternalSourceViewState { version: 1; ref: ResourceRef; rootLabel: string }
export function validateExternalSourceViewState(value: unknown): ExternalSourceViewState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || typeof state.rootLabel !== "string" || !state.rootLabel.trim()
    || !state.ref || typeof state.ref !== "object") return null;
  const ref = state.ref as Record<string, unknown>;
  if (typeof ref.rootId !== "string" || !ref.rootId.trim() || ref.rootId.includes("\0")
    || typeof ref.relativePath !== "string") return null;
  try {
    return { version: 1, ref: { rootId: ref.rootId, relativePath: normalizeResourceRelativePath(ref.relativePath) }, rootLabel: state.rootLabel };
  } catch { return null; }
}
export class ExternalSourceView implements View {
  readonly viewType = "geode-external-source";
  readonly containerEl = document.createElement("div");
  private readonly identityEl = document.createElement("div");
  private readonly bodyEl = document.createElement("div");
  private readonly refreshButton = document.createElement("button");
  private state: ExternalSourceViewState | null = null;
  private generation = 0;
  private closed = false;
  private unsubscribe?: () => void;
  private readonly handleRefresh = (): void => { void this.refresh(); };

  constructor(private readonly app: App, private readonly leaf: WorkspaceLeaf) {
    this.containerEl.className = "external-source-view";
    const toolbar = document.createElement("div");
    toolbar.className = "external-source-toolbar";
    const label = document.createElement("span");
    label.className = "external-source-readonly";
    label.textContent = "Read-only · External source";
    this.identityEl.className = "external-source-identity";
    this.refreshButton.type = "button";
    this.refreshButton.textContent = "Refresh";
    this.refreshButton.setAttribute("aria-label", "Refresh external source");
    this.refreshButton.addEventListener("click", this.handleRefresh);
    this.refreshButton.disabled = true;
    toolbar.append(label, this.refreshButton);
    this.bodyEl.className = "external-source-body";
    this.containerEl.append(toolbar, this.identityEl, this.bodyEl);
    this.showMessage("External source unavailable. Choose a Project file to open.");
    this.unsubscribe = this.app.host.externalRoots?.onChange?.(() => {
      if (this.state && !this.closed) void this.refresh();
    });
  }
  getDisplayText(): string {
    return this.state ? `${this.state.ref.relativePath.split("/").at(-1)} · ${this.state.rootLabel} (read-only)` : "External source unavailable";
  }
  getIcon(): string { return "file-code"; }
  onOpen(): void {}
  onClose(): void {
    this.closed = true;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.refreshButton.removeEventListener("click", this.handleRefresh);
    this.refreshButton.disabled = true;
    this.bodyEl.replaceChildren();
  }
  getState(): ExternalSourceViewState | null { return validateExternalSourceViewState(this.state); }
  async setState(state: unknown): Promise<void> {
    if (this.closed) return;
    this.generation++;
    this.state = validateExternalSourceViewState(state);
    this.identityEl.textContent = this.state ? `${this.state.rootLabel} · ${this.state.ref.relativePath}` : "";
    this.leaf.setPersistedState(this.getState());
    this.leaf.updateHeader();
    this.app.workspace.trigger("layout-change");
    await this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    const state = this.state;
    this.refreshButton.disabled = true;
    if (!state) {
      this.showMessage("External source unavailable: invalid saved resource identity.", true);
      return;
    }
    if (this.app.host.runtime.runtime !== "electron") {
      this.showMessage("Available on desktop. This external Project folder is not synchronized to this device.");
      return;
    }
    const host = this.app.host.externalRoots;
    if (!host) {
      this.showMessage("External source unavailable: this host does not support external Project folders.", true);
      return;
    }
    this.showMessage("Loading external source…");
    try {
      const text = await host.readText({ ...state.ref });
      if (this.closed || generation !== this.generation) return;
      const pre = document.createElement("pre");
      pre.className = "external-source-text";
      pre.tabIndex = 0;
      pre.setAttribute("aria-label", `Read-only source: ${state.ref.relativePath}`);
      const code = document.createElement("code");
      // Never parse external content as Markdown or HTML, including link syntax.
      code.textContent = text;
      pre.append(code);
      this.bodyEl.replaceChildren(pre);
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      const hostCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const code = typeof hostCode === "string" ? hostCode : error instanceof Error ? error.message : "";
      const message: Record<string, string> = {
        "not-found": "File not found. Restore the file, then Refresh.",
        "root-not-found": "Project root unavailable. Attach or reconnect the Project folder in Projects, then Refresh.",
        "root-missing": "Project folder is missing. Reconnect it in Projects, then Refresh.",
        "root-unavailable": "Project root unavailable. Reconnect it in Projects, then Refresh.",
        "permission-denied": "Permission denied. Reconnect the Project folder in Projects, then Refresh.",
        "too-large": "Unsupported file: source view accepts UTF-8 text up to 2 MiB.",
        "invalid-utf8": "Unsupported file: content is not valid UTF-8 text.",
        "unsupported-file": "Unsupported file: only UTF-8 text files can be opened.",
        "outside-root": "Unavailable link: the target is outside the granted Project root.",
        "directory-symlink": "Directory links cannot be opened or traversed.",
        "unavailable-link": "Unavailable link: the target cannot be safely opened.",
      };
      this.showMessage(message[code] ?? "External source unavailable. Check the Project folder and try Refresh.", true);
    } finally {
      if (!this.closed && generation === this.generation) this.refreshButton.disabled = false;
    }
  }
  private showMessage(text: string, error = false): void {
    const message = document.createElement("div");
    message.className = error ? "external-source-status is-error" : "external-source-status";
    message.setAttribute("role", error ? "alert" : "status");
    message.textContent = text;
    this.bodyEl.replaceChildren(message);
  }
}
