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
import {
  PickPopover,
  choosePopoverBounds,
  clampIntoWindow,
  hoverChipText,
  isElementOffscreen,
  popoverMaxHeight,
  popoverPosition,
  shouldMovePopover,
} from "../artifacts/pick-popover";
import { createRectCoalescer, type RectCoalescer } from "../artifacts/rect-coalescer";
import type { ArtifactCommentsClient } from "../artifacts/comments-client";
import { CommentsRail } from "../artifacts/comments-rail";
import { PinOverlay } from "../artifacts/pin-overlay";
import { createPinsCoordinator, type PinsCoordinator } from "../artifacts/pins-coordinator";
import type { InspectRectMessage } from "../../artifacts/inspector-protocol";

/**
 * Next animation frame, or 100 ms from now when the page is not visible (a hidden or occluded window never runs
 * animation frames, and pins must still settle). Runs the callback exactly once; returns a cancel function.
 */
function scheduleFrameOrTimeout(callback: () => void): () => void {
  let done = false;
  const run = (): void => { if (done) return; done = true; window.cancelAnimationFrame(frame); window.clearTimeout(timer); callback(); };
  const frame = window.requestAnimationFrame(run);
  const timer = window.setTimeout(run, 100);
  return () => { done = true; window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
}

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
  /** The selected element's CURRENT viewport rect (Phase 2a), reported by the guest; null until it moves. */
  private liveRect: { x: number; y: number; width: number; height: number } | null = null;
  private liveRectFor: PickState["snapshot"] = null;
  /** A selected rect that arrived after the select but before the popover opened (the screenshot await); applied on open. */
  private earlyRect: { x: number; y: number; width: number; height: number } | null = null;
  private rectCoalescer: RectCoalescer<{ x: number; y: number; width: number; height: number }> | null = null;
  private pointerInPopover = false;
  private offscreen = false;
  private lastHover: InspectorHover | null = null;
  private layoutObserver: ResizeObserver | undefined;
  private readonly onWindowResize = (): void => { this.repositionPick("layout"); this.layoutPins(); };
  private bridge: ArtifactInspectorBridge | null = null;
  private pick: PickController | null = null;
  private popover: PickPopover | null = null;
  private pickTarget: ArtifactFeedbackTarget | null = null;
  private unsubscribeFeedback: (() => void) | undefined;
  private handlerName = "the plugin";
  private guestLoaded = false;
  private guestLoadFailed = false;
  // Pinned comments (Phase 2b-i, ADR 0006 Addendum 1): the pin layer, the rail and their wiring. Present only while the
  // routed handler is v2; the wiring itself lives in pins-coordinator.ts.
  private readonly commentsButton = document.createElement("button");
  private readonly liveEl = document.createElement("div");
  private readonly railEl: CommentsRail;
  private pinLayer: PinOverlay | null = null;
  private pins: PinsCoordinator | null = null;
  private commentsClient: (ArtifactCommentsClient & { dispose(): void }) | null = null;
  private commentsRoute = "";
  private static nextRailId = 0;
  private lastFocusRefresh = 0;
  /** Re-lists when the window regains focus, for the visible, active view only (a background tab does nothing), at most once a second. */
  private readonly onWindowFocus = (): void => {
    if (document.visibilityState === "hidden" || this.containerEl.getClientRects().length === 0) return;
    const now = Date.now();
    if (now - this.lastFocusRefresh < 1000) return;
    this.lastFocusRefresh = now;
    void this.pins?.refresh();
  };
  private readonly onStageScroll = (): void => this.layoutPins();
  private unsubscribeActiveLeaf: (() => void) | undefined;

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
    this.commentsButton.className = "clickable-icon artifact-view-toolbar-btn artifact-view-comments-btn";
    this.commentsButton.type = "button";
    this.commentsButton.title = "Design comments";
    this.commentsButton.setAttribute("aria-label", "Comments");
    this.commentsButton.setAttribute("aria-expanded", "false");
    this.commentsButton.hidden = true; // hidden until the routed handler is v2
    setIcon(this.commentsButton, "message-square");
    this.commentsButton.addEventListener("click", () => { void this.toggleComments(); });
    toolbar.append(this.commentsButton);
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
    this.railEl = new CommentsRail(document, {
      onFilter: (filter) => this.pins?.setFilter(filter),
      onClearCluster: () => this.pins?.clearCluster(),
      onToggleSelect: (id, selected) => this.pins?.toggleSelect(id, selected),
      onAction: (id, action, version) => { void this.pins?.runAction(id, action, version); },
      onSendSelected: () => { void this.pins?.sendSelected(); },
      onResolveSent: () => { void this.pins?.resolveSent(); },
      onAdoptAll: () => { void this.pins?.adoptAll(); },
      onRetry: () => { void this.pins?.retryLastSend(); },
      onClose: () => { this.pins?.closeRail(); this.commentsButton.focus(); },
    });
    this.railEl.el.id = `artifact-comments-rail-${++ArtifactView.nextRailId}`;
    this.railEl.el.hidden = true;
    this.commentsButton.setAttribute("aria-controls", this.railEl.el.id);
    this.liveEl.className = "artifact-view-live";
    this.liveEl.setAttribute("role", "status");
    this.liveEl.setAttribute("aria-live", "polite");
    this.bodyEl.append(this.stageEl, this.railEl.el, this.overlayEl);
    this.containerEl.append(toolbar, this.bodyEl, this.diagnosticsEl, this.liveEl);
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
      comments: () => this.commentsClient,
      getRevision: () => this.revision,
      getViewportPreset: () => this.viewport?.preset ?? "fill",
      callbacks: {
        onHover: (hover) => this.showHover(hover),
        onSelect: (snapshot) => this.pick?.selected(snapshot, document.activeElement === frame ? "guest" : "toggle"),
        onCancel: () => { this.pick?.cancelFromGuest(); },
        onRect: (report) => this.onGuestRect(report),
        onAnchorResults: (message) => this.pins?.onAnchorResults(message),
        onAnchorRects: (message) => this.pins?.onAnchorRects(message),
        onAnchorsSent: (epoch) => this.pins?.onAnchorsSent(epoch),
      },
    });
    const controller = new PickController({
      setGuestMode: (mode) => bridge.setMode(mode),
      submit: (snapshot, comment) => bridge.submit(snapshot, comment),
      pin: async (snapshot, comment) => {
        const outcome = await bridge.pin(snapshot, comment);
        if (outcome.status === "accepted") await this.pins?.pinned(snapshot.selection.selectionId);
        return outcome;
      },
      focus: (where) => this.focusPick(where),
      changed: (state) => this.renderPick(state),
    });
    const popover = new PickPopover(document, {
      onComment: (text) => controller.setComment(text),
      onSend: () => controller.send(),
      onPin: () => controller.pin(),
      onCancel: () => { controller.cancel(); },
      onDone: () => controller.done(),
      onEscape: () => { controller.escape(); },
      onRepick: () => { controller.repick(); },
    });
    popover.el.hidden = true;
    // The popover lives on document.body (fixed position), not in the pane: in a very narrow pane it must be free to use
    // the window, and the pane clips and contains anything inside it. It is hidden whenever this view is not showing.
    const pinLayer = new PinOverlay(document, {
      onActivate: (badge) => this.pins?.activateBadge(badge),
      onEscape: () => this.focusCommentsToggle(),
    });
    this.pinLayer = pinLayer;
    this.overlayEl.replaceChildren(this.selectionBoxEl, pinLayer.el);
    document.body.appendChild(popover.el);
    this.layoutObserver = new ResizeObserver(() => { this.repositionPick("layout"); this.layoutPins(); });
    // One embedder update per animation frame, however fast the page animates the element (review A3).
    this.rectCoalescer = createRectCoalescer({
      schedule: (cb) => window.requestAnimationFrame(cb),
      cancel: (h) => window.cancelAnimationFrame(h),
      apply: (box) => {
        if (this.pick?.state.phase === "popover") { this.liveRect = box; this.repositionPick("rect"); } else this.earlyRect = box;
      },
    });
    // Do not slide the popover from under the pointer or the caret because the page moved the element (review A4).
    popover.el.addEventListener("mouseenter", () => { this.pointerInPopover = true; });
    popover.el.addEventListener("mouseleave", () => { this.pointerInPopover = false; this.repositionPick("settle"); });
    popover.el.addEventListener("focusout", () => window.setTimeout(() => this.repositionPick("settle"), 0));
    this.layoutObserver.observe(this.containerEl);
    this.layoutObserver.observe(this.stageEl);
    this.layoutObserver.observe(frame);
    this.layoutObserver.observe(popover.el); // its own height changes (the "what will be sent" disclosure) need a re-fit
    window.addEventListener("resize", this.onWindowResize);
    // Re-list when the window or this tab becomes active again (changes made while closed or in the background).
    window.addEventListener("focus", this.onWindowFocus);
    // The stage itself scrolls (a device preset larger than the pane): the pin layer follows at once, not at the next guest report.
    this.stageEl.addEventListener("scroll", this.onStageScroll, { passive: true });
    this.unsubscribeActiveLeaf = this.app.workspace.on("active-leaf-change", (leaf: unknown) => { if (leaf === this.leaf) void this.pins?.refresh(); }) as unknown as (() => void) | undefined;
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
    this.teardownComments();
    window.removeEventListener("focus", this.onWindowFocus);
    this.stageEl.removeEventListener("scroll", this.onStageScroll);
    try { this.unsubscribeActiveLeaf?.(); } catch { /* the workspace is going away */ }
    this.unsubscribeActiveLeaf = undefined;
    this.pinLayer = null;
    this.pick?.dispose();
    this.bridge?.dispose();
    this.layoutObserver?.disconnect();
    this.layoutObserver = undefined;
    this.rectCoalescer?.dispose();
    this.rectCoalescer = null;
    this.pointerInPopover = false;
    this.offscreen = false;
    this.earlyRect = null;
    window.removeEventListener("resize", this.onWindowResize);
    this.popover?.dispose();
    this.popover?.el.remove();
    this.liveRect = null;
    this.liveRectFor = null;
    this.lastHover = null;
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

  private pickAvailableNow(): boolean {
    const target = this.pickTarget;
    return !!target && !!this.webview && this.guestLoaded && !this.guestLoadFailed
      && isPickAvailable(this.registration, this.app.artifactFeedbackService, target);
  }

  /** Visible iff static + inspector + a handler passes canHandle + the guest is loaded without error. */
  private updatePickAvailability(): void {
    const target = this.pickTarget;
    const available = this.pickAvailableNow();
    if (target) this.handlerName = this.app.artifactFeedbackService.describeHandler(target) ?? this.handlerName;
    this.pickButton.hidden = !available;
    this.pick?.setAvailable(available);
    this.syncComments(available);
  }

  private focusPick(where: FocusTarget): void {
    if (where === "toggle") this.pickButton.focus();
    else if (where === "guest") this.webview?.focus();
    else if (where === "comment") this.popover?.focusComment();
    else if (where === "pins") {
      // A saved pin: its new badge when it is placed, else the Comments toggle (design 3.7).
      const target = this.pins?.focusTargetAfterPin();
      if (target?.type === "badge" && this.pinLayer?.focusBadge(target.id)) return;
      this.focusCommentsToggle();
    } else this.popover?.focusDone();
  }

  // ---- pinned comments (Phase 2b-i) ----

  /** Whether the Comments toggle is offered right now. Also gates the palette command. */
  canToggleComments(): boolean { return !this.commentsButton.hidden; }

  async toggleComments(): Promise<void> {
    if (this.canToggleComments()) await this.pins?.toggleRail();
  }

  private focusCommentsToggle(): void {
    (this.commentsButton.hidden ? this.pickButton : this.commentsButton).focus();
  }

  /**
   * Keeps the comments client and coordinator in step with the routed handler: created when it is v2, dropped when it
   * is not (Pin and the rail are hidden for a v1 handler). A registry change that does not touch THIS target's routing
   * does nothing. When the routed handler was reloaded (a new registration), only the client is replaced: the
   * coordinator keeps the rail, filter, selection and any pending Retry (same requestId), so a timed-out send is never
   * re-sent under a fresh id. A page load does not rebuild anything, so pins stay in place.
   */
  private syncComments(available: boolean): void {
    const target = this.pickTarget;
    const service = this.app.artifactFeedbackService;
    const route = available && target ? service.describeRoute(target) : null;
    const key = route && route.contractVersion === 2 ? `${route.displayName}#${target ? service.routeInstance(target) : ""}` : "";
    if (key === this.commentsRoute) return;
    // The same plugin registered again (a reload): keep the coordinator and replace only its client.
    const rebuildClientOnly = key !== "" && this.pins !== null && this.commentsRoute !== "" && key.split("#")[0] === this.commentsRoute.split("#")[0];
    if (rebuildClientOnly && target && this.pins) {
      const client = service.commentsFor(target);
      if (client) {
        const old = this.commentsClient;
        this.commentsClient = client;
        this.commentsRoute = key;
        old?.dispose();
        void this.pins.clientChanged();
        return;
      }
    }
    this.teardownComments();
    this.commentsRoute = key;
    if (!key || !target || !this.bridge) { this.pick?.setPinAvailable(false); return; }
    const client = service.commentsFor(target);
    if (!client) { this.commentsRoute = ""; this.pick?.setPinAvailable(false); return; }
    this.commentsClient = client;
    const bridge = this.bridge;
    const rail = this.railEl;
    const coordinator = createPinsCoordinator({
      getClient: () => this.commentsClient,
      bridge,
      scheduleFrame: (callback) => scheduleFrameOrTimeout(callback),
      newRequestId: () => `req_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      ui: {
        renderRail: (view) => rail.render(view),
        renderPins: (badges, busy) => this.pinLayer?.render(badges, { busy }),
        announce: (text) => { this.liveEl.textContent = ""; this.liveEl.textContent = text; },
        availability: ({ pin, rail: railAvailable, count }) => {
          this.commentsButton.hidden = !railAvailable;
          this.commentsButton.title = `Design comments (${count})`;
          this.pick?.setPinAvailable(pin);
        },
        focusRail: (focus) => { if (focus.type === "heading") rail.focusHeading(); else rail.focusRow(focus.id); },
        geometry: () => this.pinGeometry(),
        railOpenChanged: (open) => {
          // Closing by any route (button, Esc, palette command) while focus is inside the rail returns it to the toggle.
          const hadFocus = rail.el.contains(document.activeElement);
          rail.el.hidden = !open;
          this.commentsButton.setAttribute("aria-expanded", String(open));
          this.commentsButton.classList.toggle("is-active", open);
          this.layoutPins();
          if (!open && hadFocus) this.focusCommentsToggle();
        },
      },
    });
    this.pins = coordinator;
    this.layoutPins();
    void coordinator.start();
  }

  private teardownComments(): void {
    this.pins?.dispose();
    this.pins = null;
    this.commentsClient?.dispose();
    this.commentsClient = null;
    this.commentsRoute = "";
    this.railEl.el.hidden = true;
    this.commentsButton.hidden = true;
    this.commentsButton.setAttribute("aria-expanded", "false");
    this.commentsButton.classList.remove("is-active");
    this.pinLayer?.render([], { busy: false });
    this.pick?.setPinAvailable(false);
  }

  /** The two rects the pin mapping needs, read in one place (reads before writes). Null while the view is not showing. */
  private pinGeometry(): { frame: { left: number; top: number; clientLeft: number; clientTop: number }; stage: { left: number; top: number; width: number; height: number } } | null {
    const frame = this.webview;
    if (!frame) return null;
    const stage = this.stageEl.getBoundingClientRect();
    if (stage.width <= 0 || stage.height <= 0 || this.containerEl.getClientRects().length === 0) return null;
    const box = frame.getBoundingClientRect();
    return {
      frame: { left: box.left, top: box.top, clientLeft: frame.clientLeft, clientTop: frame.clientTop },
      stage: { left: stage.left, top: stage.top, width: stage.width, height: stage.height },
    };
  }

  private layoutPins(): void {
    const narrow = this.containerEl.clientWidth > 0 && this.containerEl.clientWidth < 560;
    this.railEl.setNarrow(narrow);
    this.pins?.layoutChanged();
  }

  private showHover(hover: InspectorHover): void {
    this.lastHover = hover;
    this.hoverEl.hidden = false;
    const text = hoverChipText(hover);
    // Only touch the live region when the announced text changes (a scroll tick must not re-announce a keyboard label).
    if (this.hoverEl.textContent !== text) this.hoverEl.textContent = text;
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
    if (state.snapshot !== this.liveRectFor) {
      this.liveRectFor = state.snapshot;
      // A rect the guest reported between the select and the popover is this selection's current position: keep it.
      this.liveRect = state.snapshot ? this.earlyRect : null;
      this.earlyRect = null;
      this.rectCoalescer?.reset();
      this.offscreen = false;
    }
    if (!state.snapshot) this.earlyRect = null;
    const popover = this.popover;
    if (!popover) return;
    popover.el.hidden = state.phase !== "popover";
    // No box for an element the page removed: it would tint empty space.
    this.selectionBoxEl.hidden = state.phase !== "popover" || state.elementGone;
    if (state.phase === "popover") {
      popover.render(state, this.handlerName, { offscreen: this.offscreen });
      this.positionPopover(state, "layout");
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

  /** The guest reports where the hovered or selected element is NOW (scroll, resize, mutation, or the 1 s re-send). */
  private onGuestRect(report: InspectRectMessage): void {
    if (report.target === "hover") {
      if (!report.connected || !report.rect) { this.hoverEl.hidden = true; this.hoverEl.textContent = ""; this.lastHover = null; return; }
      // The message names its element, so the chip's tag and size always belong together (a label from an older hover is dropped).
      if (report.tag) this.showHover({ tag: report.tag, rect: report.rect, via: "pointer" });
      return;
    }
    if (!report.connected || !report.rect) { this.pick?.elementChanged(); return; }
    // The same node is connected again (the page re-attached it): the gone state clears.
    this.pick?.elementReturned();
    this.rectCoalescer?.push(report.rect);
  }

  private repositionPick(reason: "layout" | "rect" | "settle"): void {
    const state = this.pick?.state;
    if (state && state.phase === "popover") this.positionPopover(state, reason);
  }

  /**
   * Marks the selected element and puts the popover below it (flipped above, clamped into the stage; in a pane too
   * narrow to be usable, clamped into the window; its height capped to the room it has so Send and Cancel stay on
   * screen). Anchors to the guest-reported live rect, so it follows scroll and resize, and is re-run when the pane or
   * window changes size. Hidden while this view is not showing.
   */
  private positionPopover(state: PickState, reason: "layout" | "rect" | "settle"): void {
    const popover = this.popover;
    const snapshot = state.snapshot;
    if (!popover || !snapshot || !this.webview) return;
    // Reads first, writes after (one forced layout per update).
    const stage = this.stageEl.getBoundingClientRect();
    const showing = stage.width > 0 && stage.height > 0 && this.containerEl.getClientRects().length > 0;
    popover.el.style.visibility = showing ? "" : "hidden";
    this.selectionBoxEl.style.visibility = showing ? "" : "hidden";
    if (!showing) return;
    const frame = this.webview.getBoundingClientRect();
    const box = this.liveRect ?? snapshot.selection.boundingBox.viewport;
    // The selected element stays visibly marked while the popover is open (the guest's own highlight is hidden so it
    // cannot appear in the screenshot). Non-interactive, clipped to the stage by the overlay.
    const ax = frame.left - stage.left + box.x;
    const ay = frame.top - stage.top + box.y;
    this.selectionBoxEl.style.left = `${Math.round(ax)}px`;
    this.selectionBoxEl.style.top = `${Math.round(ay)}px`;
    this.selectionBoxEl.style.width = `${Math.max(2, Math.round(box.width))}px`;
    this.selectionBoxEl.style.height = `${Math.max(2, Math.round(box.height))}px`;

    // A small cue when the element is scrolled out of view; the popover stays usable (QA C1).
    const offscreen = !state.elementGone && isElementOffscreen(
      { left: frame.left + box.x, top: frame.top + box.y, right: frame.left + box.x + box.width, bottom: frame.top + box.y + box.height },
      { left: stage.left, top: stage.top, right: stage.right, bottom: stage.bottom },
    );
    if (offscreen !== this.offscreen) {
      this.offscreen = offscreen;
      popover.render(state, this.handlerName, { offscreen });
    }

    const focusInside = popover.el.contains(document.activeElement);
    if (!shouldMovePopover({ reason, pointerInside: this.pointerInPopover, focusInside })) return;
    const win = { width: window.innerWidth, height: window.innerHeight };
    const bounds = choosePopoverBounds(stage, win);
    popover.el.style.maxHeight = `${popoverMaxHeight(bounds)}px`;
    const size = { width: popover.el.offsetWidth, height: Math.min(popover.el.offsetHeight, popoverMaxHeight(bounds)) };
    const placed = popoverPosition(
      { x: frame.left + box.x - bounds.left, y: frame.top + box.y - bounds.top, width: box.width, height: box.height },
      size,
      { width: bounds.width, height: bounds.height },
    );
    const final = clampIntoWindow({ left: bounds.left + placed.left, top: bounds.top + placed.top }, size, win);
    popover.el.style.left = `${Math.round(final.left)}px`;
    popover.el.style.top = `${Math.round(final.top)}px`;
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
