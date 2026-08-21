import type { App } from "../app";
import type { View, WorkspaceLeaf } from "../workspace";
import { setIcon } from "../api/icons";
import type { ArtifactDiagnostic, ArtifactRegistration } from "../../main/artifact-runtime";

type ViewportPreset = "desktop" | "tablet" | "mobile" | "custom";
interface Viewport { preset: ViewportPreset; width: number; height: number }
export interface ArtifactViewState { root: string; viewport?: Viewport }
interface ArtifactWebview extends HTMLElement { src: string; reload(): void }

const VIEWPORTS: Record<Exclude<ViewportPreset, "custom">, Viewport> = {
  desktop: { preset: "desktop", width: 1440, height: 900 },
  tablet: { preset: "tablet", width: 768, height: 1024 },
  mobile: { preset: "mobile", width: 390, height: 844 },
};

export class ArtifactView implements View {
  readonly viewType = "geode-artifact";
  readonly containerEl = document.createElement("div");
  private readonly stageEl = document.createElement("div");
  private readonly statusEl = document.createElement("div");
  private readonly diagnosticsEl = document.createElement("div");
  private readonly diagnosticsButton = document.createElement("button");
  private registration: ArtifactRegistration | null = null;
  private webview: ArtifactWebview | null = null;
  private root = "";
  private viewport: Viewport | undefined;
  private loadGeneration = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private revision = 0;

  constructor(private readonly app: App, private readonly leaf: WorkspaceLeaf) {
    this.containerEl.className = "artifact-view";
    const toolbar = document.createElement("div");
    toolbar.className = "artifact-view-toolbar";
    toolbar.append(this.iconButton("rotate-cw", "Reload artifact", () => this.webview?.reload()));
    for (const preset of ["desktop", "tablet", "mobile"] as const) {
      const button = document.createElement("button");
      button.className = "artifact-view-viewport-btn";
      button.type = "button";
      button.dataset.viewport = preset;
      button.textContent = preset[0].toUpperCase();
      button.title = `${preset}: ${VIEWPORTS[preset].width} × ${VIEWPORTS[preset].height}`;
      button.setAttribute("aria-label", `${preset} viewport`);
      button.addEventListener("click", () => this.applyViewport(VIEWPORTS[preset]));
      toolbar.append(button);
    }
    toolbar.append(this.iconButton("camera", "Capture artifact screenshot", () => { void this.capture(); }));
    this.diagnosticsButton.className = "artifact-view-diagnostics-btn";
    this.diagnosticsButton.type = "button";
    this.diagnosticsButton.textContent = "Diagnostics 0";
    this.diagnosticsButton.setAttribute("aria-expanded", "false");
    this.diagnosticsButton.addEventListener("click", () => {
      this.diagnosticsEl.toggleAttribute("hidden");
      this.diagnosticsButton.setAttribute("aria-expanded", String(!this.diagnosticsEl.hidden));
    });
    toolbar.append(this.diagnosticsButton);
    this.statusEl.className = "artifact-view-status";
    this.statusEl.textContent = "Waiting for artifact…";
    toolbar.append(this.statusEl);
    this.stageEl.className = "artifact-view-stage";
    this.diagnosticsEl.className = "artifact-view-diagnostics";
    this.diagnosticsEl.hidden = true;
    this.containerEl.append(toolbar, this.stageEl, this.diagnosticsEl);
  }

  private iconButton(icon: string, label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "clickable-icon artifact-view-toolbar-btn";
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    setIcon(button, icon);
    button.addEventListener("click", action);
    return button;
  }

  getDisplayText(): string { return this.registration?.title ?? "Artifact"; }
  getIcon(): string { return "layout-template"; }
  onOpen(): void {}

  async setState(state: ArtifactViewState): Promise<void> {
    if (!state || typeof state.root !== "string" || !state.root.trim()) {
      this.showError("Artifact root is missing.");
      return;
    }
    this.root = state.root;
    this.viewport = state.viewport;
    this.persistState();
    await this.load(this.root);
  }

  getState(): ArtifactViewState { return { root: this.root, viewport: this.viewport }; }
  private persistState(): void {
    this.leaf.setPersistedState(this.getState());
    this.app.workspace.trigger("layout-change");
  }

  private applyViewport(viewport: Viewport): void {
    this.viewport = viewport;
    if (this.webview) {
      this.webview.style.width = `${viewport.width}px`;
      this.webview.style.height = `${viewport.height}px`;
    }
    this.statusEl.textContent = `${viewport.width} × ${viewport.height}`;
    for (const button of this.containerEl.querySelectorAll<HTMLElement>("[data-viewport]")) {
      button.classList.toggle("is-active", button.dataset.viewport === viewport.preset);
    }
    this.persistState();
  }

  private async load(root: string): Promise<void> {
    const generation = ++this.loadGeneration;
    await this.release();
    this.stageEl.replaceChildren();
    this.statusEl.textContent = "Validating artifact…";
    try {
      const result = await window.geode.registerArtifact(root);
      if (!result.ok) {
        const details = result.error.issues?.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
        this.showError(details ? `${result.error.message}\n${details}` : result.error.message);
        return;
      }
      const registration = result.registration;
      if (generation !== this.loadGeneration) {
        await window.geode.unregisterArtifact(registration.registrationId);
        return;
      }
      this.registration = registration;
      this.viewport ??= registration.viewport;
      this.leaf.updateHeader();
      const frame = document.createElement("webview") as unknown as ArtifactWebview;
      frame.className = "artifact-view-frame";
      frame.setAttribute("partition", registration.partition);
      frame.setAttribute("aria-label", registration.title);
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
      this.applyViewport(this.viewport);
      this.pollTimer = setInterval(() => { void this.pollRuntime(); }, 400);
    } catch (error) {
      if (generation === this.loadGeneration) this.showError((error as Error).message || "Artifact could not be opened.");
    }
  }

  private async pollRuntime(): Promise<void> {
    if (!this.registration) return;
    const state = await window.geode.getArtifactState(this.registration.registrationId).catch(() => null);
    if (!state) return;
    if (state.revision > this.revision) {
      this.revision = state.revision;
      this.webview?.reload();
      this.statusEl.textContent = `Reloaded · ${this.viewport?.width} × ${this.viewport?.height}`;
    }
    this.renderDiagnostics(state.diagnostics);
  }

  private renderDiagnostics(diagnostics: ArtifactDiagnostic[]): void {
    this.diagnosticsButton.textContent = `Diagnostics ${diagnostics.length}`;
    this.diagnosticsButton.classList.toggle("has-errors", diagnostics.some((item) => item.level === "error"));
    this.diagnosticsEl.replaceChildren(...diagnostics.map((item) => {
      const row = document.createElement("div");
      row.className = `artifact-view-diagnostic is-${item.level}`;
      row.textContent = `${item.level}: ${item.message}${item.line ? ` (${item.line})` : ""}`;
      return row;
    }));
  }

  private async capture(): Promise<void> {
    try {
      const capture = await window.geode.captureArtifact(this.root);
      this.statusEl.textContent = `Captured ${capture.width} × ${capture.height}`;
    } catch (error) {
      this.statusEl.textContent = `Capture failed: ${(error as Error).message}`;
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
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.webview?.remove();
    this.webview = null;
    this.revision = 0;
    const registration = this.registration;
    this.registration = null;
    if (registration) await window.geode.unregisterArtifact(registration.registrationId);
  }

  async onClose(): Promise<void> {
    this.loadGeneration += 1;
    await this.release();
  }
}
