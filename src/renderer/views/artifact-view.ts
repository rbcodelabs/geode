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
import { ArtifactInspectorBridge, artifactFeedbackTarget, isPickAvailable, type InspectorHover, type InspectorWebview } from "./artifact-inspector-bridge";
import type { ArtifactFeedbackTarget } from "../../artifacts/feedback-contract";
import { PickController, type FocusTarget, type PickState } from "../artifacts/pick-controller";
import { PickPopover, popoverPosition } from "../artifacts/pick-popover";

type ViewportPreset = "desktop" | "tablet" | "mobile" | "custom" | "fill";
interface Viewport { preset: ViewportPreset; width: number; height: number }
export interface ArtifactViewState {
  root: string;
  viewport?: Viewport;
  /** Dev server URL for `nextjs` artifacts. Untrusted here; main re-validates it on registration. */
  url?: string;
  runtime?: "static" | "nextjs";
}
interface ArtifactWebview extends HTMLElement { src: string; reload(): void; send(channel: string, ...args: unknown[]): void }
const PICK_STATUS = "Pick mode: click an element, or use [ ] and Enter. Esc exits.";
interface WebviewIpcMessageEvent extends Event { channel: string; args: unknown[] }

const VIEWPORTS: Record<Exclude<ViewportPreset, "custom">, Viewport> = {
  // Width/height are fallbacks for status text; a fill frame sizes to the pane.
  fill: { preset: "fill", width: 1440, height: 900 },
  desktop: { preset: "desktop", width: 1440, height: 900 },
  tablet: { preset: "tablet", width: 768, height: 1024 },
  mobile: { preset: "mobile", width: 390, height: 844 },
};

const VIEWPORT_CONTROLS: Record<Exclude<ViewportPreset, "custom">, { icon: string; label: string }> = {
  fill: { icon: "maximize-2", label: "Fill pane" },
  desktop: { icon: "monitor", label: "Desktop" },
  tablet: { icon: "tablet", label: "Tablet" },
  mobile: { icon: "smartphone", label: "Mobile" },
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
  private devServerUrl: string | undefined;
  private viewport: Viewport | undefined;
  private loadGeneration = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private revision = 0;
  private unwatchVault: (() => void) | undefined;
  private readonly vaultBadgeEl = document.createElement("span");
  // Element picker (ADR 0006 D8). Present only for a static artifact whose inspector preload is attached.
  private readonly pickButton = document.createElement("button");
  private readonly hoverEl = document.createElement("span");
  private readonly overlayEl = document.createElement("div");
  private readonly bodyEl = document.createElement("div");
  private readonly selectionBoxEl = document.createElement("div");
  private readonly sentChipEl = document.createElement("span");
  private lastPickPhase: PickState["phase"] = "off";
  private bridge: ArtifactInspectorBridge | null = null;
  private pick: PickController | null = null;
  private popover: PickPopover | null = null;
  private pickTarget: ArtifactFeedbackTarget | null = null;
  private unsubscribeFeedback: (() => void) | undefined;
  private handlerName = "the plugin";
  private guestLoaded = false;
  private guestLoadFailed = false;

  constructor(private readonly app: App, private readonly leaf: WorkspaceLeaf) {
    this.containerEl.className = "artifact-view";
    const toolbar = document.createElement("div");
    toolbar.className = "artifact-view-toolbar";
    // Routed through the action so the button, Cmd+R and the tab context menu
    // share one implementation.
    toolbar.append(this.iconButton("rotate-cw", "Reload artifact", () => {
      void this.app.actions.execute("web.reload", { reloadable: this, leaf: this.leaf });
    }));
    // One segmented control instead of four loose buttons: icon-only, with the
    // name and size in the tooltip and the active choice exposed via aria-pressed.
    const viewports = document.createElement("div");
    viewports.className = "artifact-view-viewports";
    viewports.setAttribute("role", "group");
    viewports.setAttribute("aria-label", "Viewport size");
    for (const preset of ["fill", "desktop", "tablet", "mobile"] as const) {
      const meta = VIEWPORT_CONTROLS[preset];
      const button = document.createElement("button");
      button.className = "clickable-icon artifact-view-viewport-btn";
      button.type = "button";
      button.dataset.viewport = preset;
      button.title = preset === "fill" ? meta.label : `${meta.label} (${VIEWPORTS[preset].width} × ${VIEWPORTS[preset].height})`;
      button.setAttribute("aria-label", `${meta.label} viewport`);
      button.setAttribute("aria-pressed", "false");
      setIcon(button, meta.icon);
      button.addEventListener("click", () => this.applyViewport(VIEWPORTS[preset]));
      viewports.append(button);
    }
    toolbar.append(viewports);
    toolbar.append(this.iconButton("camera", "Capture artifact screenshot", () => {
      // The highlight must not appear in a manual capture: pick mode goes off first.
      this.pick?.captureRequested();
      void this.capture();
    }));
    this.pickButton.className = "clickable-icon artifact-view-toolbar-btn artifact-view-pick-btn";
    this.pickButton.type = "button";
    this.pickButton.title = "Pick element to comment";
    this.pickButton.setAttribute("aria-label", "Pick element to comment");
    this.pickButton.setAttribute("aria-pressed", "false");
    this.pickButton.hidden = true; // hidden, not disabled, until a handler can receive feedback
    setIcon(this.pickButton, "mouse-pointer-click");
    // Enter/Space on the button arrive as a click with detail 0.
    this.pickButton.addEventListener("click", (event) => this.togglePick(event.detail === 0 ? "keyboard" : "pointer"));
    toolbar.append(this.pickButton);
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
    this.hoverEl.className = "artifact-view-hover";
    this.hoverEl.hidden = true;
    this.sentChipEl.className = "artifact-view-sent";
    this.sentChipEl.hidden = true;
    toolbar.append(this.vaultBadgeEl, this.statusEl, this.hoverEl, this.sentChipEl);
    this.stageEl.className = "artifact-view-stage";
    this.diagnosticsEl.className = "artifact-view-diagnostics";
    this.diagnosticsEl.hidden = true;
    // The overlay covers exactly the stage (it is a sibling inside the same relative body), so the popover and the
    // selection box are stage-relative and clipped to it.
    this.bodyEl.className = "artifact-view-body";
    this.overlayEl.className = "artifact-view-overlay";
    this.selectionBoxEl.className = "artifact-view-selection-box";
    this.selectionBoxEl.hidden = true;
    this.bodyEl.append(this.stageEl, this.overlayEl);
    this.containerEl.append(toolbar, this.bodyEl, this.diagnosticsEl);
    this.containerEl.addEventListener("keydown", (event) => this.onContainerKeydown(event));
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
    this.devServerUrl = typeof state.url === "string" && state.url ? state.url : undefined;
    this.viewport = state.viewport;
    this.persistState();
    await this.load(this.root);
  }

  getState(): ArtifactViewState {
    return {
      root: this.root,
      viewport: this.viewport,
      ...(this.devServerUrl ? { url: this.devServerUrl, runtime: "nextjs" as const } : {}),
    };
  }
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
    if (this.pick?.state.phase === "off" || !this.pick) this.statusEl.textContent = this.viewportStatus();
    for (const button of this.containerEl.querySelectorAll<HTMLElement>("[data-viewport]")) {
      const active = button.dataset.viewport === viewport.preset;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    this.persistState();
  }

  private viewportStatus(): string {
    const viewport = this.viewport;
    return !viewport || viewport.preset === "fill" ? "Fill" : `${viewport.width} × ${viewport.height}`;
  }

  private async load(root: string): Promise<void> {
    const generation = ++this.loadGeneration;
    await this.release();
    this.stageEl.replaceChildren();
    this.statusEl.textContent = "Validating artifact…";
    try {
      const result = await window.geode.registerArtifact(
        root,
        this.devServerUrl ? { devServerUrl: this.devServerUrl } : undefined,
      );
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
      frame.addEventListener("did-finish-load", () => {
        this.guestLoaded = true;
        this.guestLoadFailed = false;
        this.updatePickAvailability();
      });
      frame.addEventListener("did-fail-load", (event) => {
        const detail = event as unknown as { errorDescription?: string; validatedURL?: string; errorCode?: number; isMainFrame?: boolean };
        // ERR_ABORTED (-3) is a superseded load (a reload racing the previous one), not a failure.
        if (detail.errorCode !== -3 && detail.isMainFrame !== false) { this.guestLoadFailed = true; this.updatePickAvailability(); }
        if (detail.validatedURL === registration.entryUrl) {
          this.containerEl.dataset.loadError = detail.errorDescription || "Artifact failed to load.";
          this.statusEl.textContent = `Artifact unavailable: ${this.containerEl.dataset.loadError}`;
        }
      });
      if (registration.vault) this.attachVaultBridge(frame, registration);
      this.webview = frame;
      if (registration.runtime === "static" && registration.inspector) this.attachInspector(frame, registration);
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

  // ---- element picker (ADR 0006 D8) ----

  /** Whether the Pick toggle is offered right now. Also gates the palette command. */
  canTogglePick(): boolean {
    return !this.pickButton.hidden;
  }

  togglePick(via: "pointer" | "keyboard"): void {
    if (this.canTogglePick()) this.pick?.toggle(via);
  }

  private attachInspector(frame: ArtifactWebview, registration: ArtifactRegistration): void {
    const target = artifactFeedbackTarget(registration, this.root);
    const registry = this.app.artifactFeedbackService;
    this.pickTarget = target;
    this.guestLoaded = false;
    this.guestLoadFailed = false;
    const bridge = new ArtifactInspectorBridge({
      webview: frame as unknown as InspectorWebview,
      registration,
      target,
      registry,
      getRevision: () => this.revision,
      getViewportPreset: () => this.viewport?.preset ?? "fill",
      callbacks: {
        onHover: (hover) => this.showHover(hover),
        onSelect: (snapshot) => this.pick?.selected(snapshot, document.activeElement === frame ? "guest" : "toggle"),
        onCancel: () => { this.pick?.cancelFromGuest(); },
      },
    });
    const controller = new PickController({
      setGuestMode: (mode) => bridge.setMode(mode),
      submit: (snapshot, comment) => bridge.submit(snapshot, comment),
      focus: (where) => this.focusPick(where),
      changed: (state) => this.renderPick(state),
    });
    const popover = new PickPopover(document, {
      onComment: (text) => controller.setComment(text),
      onSend: () => controller.send(),
      onCancel: () => { controller.cancel(); },
      onDone: () => controller.done(),
      onEscape: () => { controller.escape(); },
    });
    popover.el.hidden = true;
    this.overlayEl.replaceChildren(this.selectionBoxEl, popover.el);
    this.bridge = bridge;
    this.pick = controller;
    this.popover = popover;
    // dom-ready fires for every document the guest starts; an open popover then goes stale.
    frame.addEventListener("dom-ready", () => controller.pageReloaded());
    this.unsubscribeFeedback = registry.onDidChange(() => this.updatePickAvailability());
    this.updatePickAvailability();
  }

  private detachInspector(): void {
    this.unsubscribeFeedback?.();
    this.unsubscribeFeedback = undefined;
    this.pick?.dispose();
    this.bridge?.dispose();
    this.pick = null;
    this.bridge = null;
    this.popover = null;
    this.pickTarget = null;
    this.guestLoaded = false;
    this.guestLoadFailed = false;
    this.overlayEl.replaceChildren();
    this.selectionBoxEl.hidden = true;
    this.sentChipEl.hidden = true;
    this.lastPickPhase = "off";
    this.pickButton.hidden = true;
    this.pickButton.setAttribute("aria-pressed", "false");
    this.pickButton.classList.remove("is-active");
    this.hoverEl.hidden = true;
    this.containerEl.classList.remove("is-picking");
  }

  /** Visible iff static + inspector + a handler passes canHandle + the guest is loaded without error. */
  private updatePickAvailability(): void {
    const target = this.pickTarget;
    const available = !!target && !!this.webview && this.guestLoaded && !this.guestLoadFailed
      && isPickAvailable(this.registration, this.app.artifactFeedbackService, target);
    if (target) this.handlerName = this.app.artifactFeedbackService.describeHandler(target) ?? this.handlerName;
    this.pickButton.hidden = !available;
    this.pick?.setAvailable(available);
  }

  private focusPick(where: FocusTarget): void {
    if (where === "toggle") this.pickButton.focus();
    else if (where === "guest") this.webview?.focus();
    else if (where === "comment") this.popover?.focusComment();
    else this.popover?.focusDone();
  }

  private showHover(hover: InspectorHover): void {
    this.hoverEl.hidden = false;
    this.hoverEl.textContent = hover.label ? `<${hover.tag}> ${hover.label}` : `<${hover.tag}> ${Math.round(hover.rect.width)} × ${Math.round(hover.rect.height)}`;
    // Pointer hovering is visual only; a keyboard walk is announced.
    this.hoverEl.setAttribute("aria-live", hover.via === "keyboard" ? "polite" : "off");
  }

  private renderPick(state: PickState): void {
    const picking = state.phase !== "off";
    this.pickButton.setAttribute("aria-pressed", String(picking));
    this.pickButton.classList.toggle("is-active", picking);
    this.containerEl.classList.toggle("is-picking", picking);
    if (state.phase === "pick") this.statusEl.textContent = PICK_STATUS;
    else if (state.phase === "off" && this.statusEl.textContent === PICK_STATUS) this.statusEl.textContent = this.viewportStatus();
    if (state.phase !== "pick") { this.hoverEl.hidden = true; this.hoverEl.textContent = ""; }
    // A comment that was taken leaves a short, persistent confirmation until the next pick (no pins in Phase 1).
    if (state.phase === "pick" && this.lastPickPhase === "off") this.sentChipEl.hidden = true;
    if (state.phase === "off" && this.lastPickPhase === "popover" && this.lastSubmit === "accepted") this.showSentChip();
    this.lastPickPhase = state.phase;
    this.lastSubmit = state.submit;
    if (state.submit === "accepted") this.lastOutcomeMessage = state.outcome?.message;
    const popover = this.popover;
    if (!popover) return;
    popover.el.hidden = state.phase !== "popover";
    this.selectionBoxEl.hidden = state.phase !== "popover";
    if (state.phase === "popover") {
      popover.render(state, this.handlerName);
      this.positionPopover(state);
    }
  }

  private lastSubmit: PickState["submit"] = "idle";
  private lastOutcomeMessage: string | undefined;

  private showSentChip(): void {
    const chip = this.sentChipEl;
    chip.title = `Comment sent to ${this.handlerName}`;
    const icon = document.createElement("span");
    icon.className = "artifact-view-sent-icon";
    icon.setAttribute("aria-hidden", "true");
    setIcon(icon, "circle-check");
    const text = document.createElement("span");
    text.textContent = this.lastOutcomeMessage || "Sent";
    chip.replaceChildren(icon, text);
    chip.hidden = false;
  }

  /** Below the selected element, flipped above or clamped to the stage; it does not follow scrolling. */
  private positionPopover(state: PickState): void {
    const popover = this.popover;
    const snapshot = state.snapshot;
    if (!popover || !snapshot || !this.webview) return;
    const stage = this.stageEl.getBoundingClientRect();
    const frame = this.webview.getBoundingClientRect();
    const box = snapshot.selection.boundingBox.viewport;
    const anchor = { x: frame.left - stage.left + box.x, y: frame.top - stage.top + box.y, width: box.width, height: box.height };
    // The selected element stays visibly marked while the popover is open (the guest's own highlight is hidden
    // so it cannot appear in the screenshot). Non-interactive, clipped to the stage by the overlay.
    this.selectionBoxEl.style.left = `${Math.round(anchor.x)}px`;
    this.selectionBoxEl.style.top = `${Math.round(anchor.y)}px`;
    this.selectionBoxEl.style.width = `${Math.max(2, Math.round(anchor.width))}px`;
    this.selectionBoxEl.style.height = `${Math.max(2, Math.round(anchor.height))}px`;
    const placed = popoverPosition(
      anchor,
      { width: popover.el.offsetWidth, height: popover.el.offsetHeight },
      { width: stage.width, height: stage.height },
    );
    popover.el.style.left = `${Math.round(placed.left)}px`;
    popover.el.style.top = `${Math.round(placed.top)}px`;
  }

  /** Esc and the [ ] walk keys while focus is in the embedder chrome (toolbar, popover). */
  private onContainerKeydown(event: KeyboardEvent): void {
    const pick = this.pick;
    if (!pick || event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape") {
      if (pick.escape()) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    if (pick.state.phase !== "pick" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    if (event.key === "[" || event.key === "]") {
      event.preventDefault();
      this.bridge?.sendKey(event.key === "[" ? "parent" : "child");
    }
  }

  private async pollRuntime(): Promise<void> {
    if (!this.registration) return;
    const state = await window.geode.getArtifactState(this.registration.registrationId).catch(() => null);
    if (!state) return;
    if (state.revision > this.revision) {
      this.revision = state.revision;
      this.webview?.reload();
      if (!this.pick || this.pick.state.phase === "off") {
        this.statusEl.textContent = `Reloaded · ${this.viewport?.preset === "fill" ? "Fill" : `${this.viewport?.width} × ${this.viewport?.height}`}`;
      }
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
      const capture = await window.geode.captureArtifact(this.root, this.devServerUrl ? { url: this.devServerUrl } : undefined);
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
    this.detachInspector();
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
