import type { App } from "../app";
import type { ReloadableView, View, WorkspaceLeaf } from "../workspace";
import { setIcon } from "../api/icons";
import type { ArtifactDiagnostic, ArtifactRegistration } from "../../main/artifact-runtime";
import {
  ARTIFACT_VAULT_CHANGE_CHANNEL,
  ARTIFACT_VAULT_QUERY_CHANNEL,
  ARTIFACT_VAULT_RESPONSE_CHANNEL,
} from "../../artifacts/guest-protocol";
import { ArtifactVaultBridge } from "../artifacts/vault-bridge";

type ViewportPreset = "desktop" | "tablet" | "mobile" | "custom" | "fill";
interface Viewport { preset: ViewportPreset; width: number; height: number }
export interface ArtifactViewState { root: string; viewport?: Viewport }
interface ArtifactWebview extends HTMLElement { src: string; reload(): void; send(channel: string, ...args: unknown[]): void }
interface WebviewIpcMessageEvent extends Event { channel: string; args: unknown[] }

const VIEWPORTS: Record<Exclude<ViewportPreset, "custom">, Viewport> = {
  // Width/height are fallbacks for status text; a fill frame sizes to the pane.
  fill: { preset: "fill", width: 1440, height: 900 },
  desktop: { preset: "desktop", width: 1440, height: 900 },
  tablet: { preset: "tablet", width: 768, height: 1024 },
  mobile: { preset: "mobile", width: 390, height: 844 },
};

export class ArtifactView implements View, ReloadableView {
  readonly viewType = "geode-artifact";
  readonly reloadLabel = "Reload artifact";
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
  private unwatchVault: (() => void) | undefined;
  private readonly vaultBadgeEl = document.createElement("span");

  constructor(private readonly app: App, private readonly leaf: WorkspaceLeaf) {
    this.containerEl.className = "artifact-view";
    const toolbar = document.createElement("div");
    toolbar.className = "artifact-view-toolbar";
    // Routed through the action so the button, Cmd+R and the tab context menu
    // share one implementation.
    toolbar.append(this.iconButton("rotate-cw", "Reload artifact", () => {
      void this.app.actions.execute("web.reload", { reloadable: this, leaf: this.leaf });
    }));
    for (const preset of ["fill", "desktop", "tablet", "mobile"] as const) {
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
    this.vaultBadgeEl.className = "artifact-view-vault-badge";
    this.vaultBadgeEl.hidden = true;
    toolbar.append(this.vaultBadgeEl, this.statusEl);
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

  /**
   * ReloadableView. `webview` is null exactly when `load()` bailed — a
   * missing root, a manifest that failed validation, a thrown error — which
   * is precisely when the user wants to retry, so fall back to re-running the
   * load rather than doing nothing.
   */
  reload(): void {
    if (this.webview) this.webview.reload();
    else void this.load(this.root);
  }

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
      const fill = viewport.preset === "fill";
      this.webview.style.width = fill ? "100%" : `${viewport.width}px`;
      this.webview.style.height = fill ? "100%" : `${viewport.height}px`;
    }
    const fill = viewport.preset === "fill";
    this.containerEl.classList.toggle("is-fill", fill);
    this.statusEl.textContent = fill ? "Fill" : `${viewport.width} × ${viewport.height}`;
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
      // Fill is the default so an artifact uses the whole pane. A viewport the user
      // picked (persisted in the view state) still wins; the manifest viewport is only a hint.
      this.viewport ??= VIEWPORTS.fill;
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
      if (registration.vault) this.attachVaultBridge(frame, registration);
      this.webview = frame;
      this.stageEl.appendChild(frame);
      this.applyViewport(this.viewport);
      this.pollTimer = setInterval(() => { void this.pollRuntime(); }, 400);
    } catch (error) {
      if (generation === this.loadGeneration) this.showError((error as Error).message || "Artifact could not be opened.");
    }
  }

  /**
   * Serve window.geodeArtifact for an artifact whose manifest opted into vault
   * reads. The guest preload only ever talks to this embedder (sendToHost);
   * each request is validated against the manifest allowlist before any vault
   * access, and the guest is told *that* the vault changed, never what.
   */
  private attachVaultBridge(frame: ArtifactWebview, registration: ArtifactRegistration): void {
    const grant = registration.vault;
    if (!grant) return;
    const bridge = new ArtifactVaultBridge(this.app.vault, this.app.metadataCache, grant.allowlist);
    const safeSend = (channel: string, payload: unknown) => {
      try { frame.send(channel, payload); } catch { /* guest not ready or already gone */ }
    };
    frame.addEventListener("ipc-message", (event) => {
      const message = event as WebviewIpcMessageEvent;
      if (message.channel !== ARTIFACT_VAULT_QUERY_CHANNEL) return;
      const body = message.args[0] as { id?: unknown; request?: unknown } | null;
      if (!body || typeof body !== "object" || typeof body.id !== "number") return;
      const id = body.id;
      void bridge.query(body.request).then((result) => safeSend(ARTIFACT_VAULT_RESPONSE_CHANNEL, { id, result }));
    });
    this.unwatchVault = bridge.watch(() => safeSend(ARTIFACT_VAULT_CHANGE_CHANNEL, {}));
    this.vaultBadgeEl.hidden = false;
    this.vaultBadgeEl.textContent = "Vault: read";
    this.vaultBadgeEl.title = `This artifact may read Bases results from:\n${grant.allowlist.join("\n")}`;
  }

  private async pollRuntime(): Promise<void> {
    if (!this.registration) return;
    const state = await window.geode.getArtifactState(this.registration.registrationId).catch(() => null);
    if (!state) return;
    if (state.revision > this.revision) {
      this.revision = state.revision;
      this.webview?.reload();
      this.statusEl.textContent = `Reloaded · ${this.viewport?.preset === "fill" ? "Fill" : `${this.viewport?.width} × ${this.viewport?.height}`}`;
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
    this.unwatchVault?.();
    this.unwatchVault = undefined;
    this.vaultBadgeEl.hidden = true;
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
