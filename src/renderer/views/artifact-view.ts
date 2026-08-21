import type { App } from "../app";
import type { View, WorkspaceLeaf } from "../workspace";
import { setIcon } from "../api/icons";
import type { ArtifactRegistration } from "../../main/artifact-runtime";

export interface ArtifactViewState {
  root: string;
}

interface ArtifactWebview extends HTMLElement {
  src: string;
  reload(): void;
}

export class ArtifactView implements View {
  readonly viewType = "geode-artifact";
  readonly containerEl = document.createElement("div");
  private readonly stageEl = document.createElement("div");
  private readonly statusEl = document.createElement("div");
  private registration: ArtifactRegistration | null = null;
  private webview: ArtifactWebview | null = null;
  private root = "";
  private loadGeneration = 0;

  constructor(
    private readonly app: App,
    private readonly leaf: WorkspaceLeaf,
  ) {
    this.containerEl.className = "artifact-view";
    const toolbar = document.createElement("div");
    toolbar.className = "artifact-view-toolbar";

    const reload = document.createElement("button");
    reload.className = "clickable-icon artifact-view-toolbar-btn";
    reload.type = "button";
    reload.title = "Reload artifact";
    reload.setAttribute("aria-label", "Reload artifact");
    setIcon(reload, "rotate-cw");
    reload.addEventListener("click", () => this.webview?.reload());

    this.statusEl.className = "artifact-view-status";
    this.statusEl.textContent = "Waiting for artifact…";
    toolbar.append(reload, this.statusEl);
    this.stageEl.className = "artifact-view-stage";
    this.containerEl.append(toolbar, this.stageEl);
  }

  getDisplayText(): string {
    return this.registration?.title ?? "Artifact";
  }

  getIcon(): string {
    return "layout-template";
  }

  onOpen(): void {}

  async setState(state: ArtifactViewState): Promise<void> {
    if (!state || typeof state.root !== "string" || !state.root.trim()) {
      this.showError("Artifact root is missing.");
      return;
    }
    this.root = state.root;
    this.leaf.setPersistedState({ root: this.root });
    await this.load(this.root);
  }

  getState(): ArtifactViewState {
    return { root: this.root };
  }

  private async load(root: string): Promise<void> {
    const generation = ++this.loadGeneration;
    await this.release();
    this.stageEl.replaceChildren();
    this.statusEl.textContent = "Validating artifact…";
    try {
      const result = await window.geode.registerArtifact(root);
      if (!result.ok) {
        const details = result.error.issues
          ?.map((issue) => `${issue.path}: ${issue.message}`)
          .join("\n");
        this.showError(details ? `${result.error.message}\n${details}` : result.error.message);
        return;
      }
      const registration = result.registration;
      if (generation !== this.loadGeneration) {
        await window.geode.unregisterArtifact(registration.registrationId);
        return;
      }
      this.registration = registration;
      this.leaf.updateHeader();
      this.statusEl.textContent = `${registration.viewport.width} × ${registration.viewport.height}`;

      const frame = document.createElement("webview") as unknown as ArtifactWebview;
      frame.className = "artifact-view-frame";
      frame.setAttribute("partition", registration.partition);
      frame.setAttribute("aria-label", registration.title);
      frame.style.width = `${registration.viewport.width}px`;
      frame.style.height = `${registration.viewport.height}px`;
      frame.src = registration.entryUrl;
      frame.addEventListener("did-fail-load", (event) => {
        const detail = event as unknown as { errorDescription?: string; validatedURL?: string };
        if (detail.validatedURL === registration.entryUrl) {
          this.containerEl.dataset.loadError = detail.errorDescription || "Artifact failed to load.";
          this.statusEl.textContent = `Artifact unavailable: ${this.containerEl.dataset.loadError}`;
        }
      });
      this.webview = frame;
      this.stageEl.appendChild(frame);
      this.app.workspace.trigger("layout-change");
    } catch (error) {
      if (generation === this.loadGeneration) this.showError((error as Error).message || "Artifact could not be opened.");
    }
  }

  private showError(message: string): void {
    this.statusEl.textContent = "Artifact unavailable";
    const error = document.createElement("div");
    error.className = "artifact-view-error";
    error.setAttribute("role", "alert");
    error.textContent = message;
    this.stageEl.replaceChildren(error);
  }

  private async release(): Promise<void> {
    this.webview?.remove();
    this.webview = null;
    const registration = this.registration;
    this.registration = null;
    if (registration) await window.geode.unregisterArtifact(registration.registrationId);
  }

  async onClose(): Promise<void> {
    this.loadGeneration += 1;
    await this.release();
  }
}
