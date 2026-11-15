import type { App } from "../app";
import type { ReloadableView, View, WorkspaceLeaf } from "../workspace";
import { setIcon } from "../api/icons";
import { describeGuestCrashCause } from "./web-view-crash-message";
import {
  VIEWPORTS,
  VIEWPORT_CONTROLS,
  VIEWPORT_PRESET_ORDER,
  normalizeViewport,
  type Viewport,
  type ViewportPreset,
} from "./viewport-presets";
import type { InspectRectMessage } from "../../artifacts/inspector-protocol";
import type { WebViewerPageTarget } from "../../web-viewer/feedback-contract";
import {
  cleanThreadLabel,
  type WebViewerFeedbackOutcome,
} from "../web-viewer/feedback-registry";
import {
  WebViewerInspectorBridge,
  type InspectorHover,
  type InspectorWebview,
  type WebViewerSelectionSnapshot,
} from "./web-viewer-inspector-bridge";
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
import { selectionBoxToStage, type BoxRect, type GuestViewport } from "../artifacts/pin-collapse";

export type { Viewport, ViewportPreset };

/**
 * State shape matches Obsidian's Web Viewer (`{ url }`) in the default `fill`
 * mode so `leaf.setViewState({ type: "webviewer", state: { url } })` from any
 * hosted plugin works unmodified, while persisting an optional `viewport` when
 * a non-fill responsive preset is active.
 */
export interface WebViewState {
  url: string;
  viewport?: Viewport;
}

/** True when `input` already looks like a URL or a bare/pathed domain — the two branches `resolveWebInput` resolves without going through the search engine. */
export function isUrlShaped(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^[^\s/]+\.[^\s/]+/.test(input);
}

/**
 * The single heuristic for "is this text a URL, a bare domain, or a search
 * query" — used by the Web Viewer's address bar (`WebView.navigate`) and the
 * New Tab universal picker. Keep the regexes here as the one source of truth;
 * do not duplicate them elsewhere.
 */
export function resolveWebInput(input: string, searchEngine: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : /^[^\s/]+\.[^\s/]+/.test(input)
      ? `https://${input}`
      : `${searchEngine}${encodeURIComponent(input)}`;
}

/**
 * Parses an embedder-observed main-frame URL, accepting only committed `http:`
 * and `https:` pages with a non-opaque origin (`<= 2048` UTF-16 units).
 */
export function parseHttpPageUrl(rawUrl: string): { url: string; origin: string } | null {
  if (typeof rawUrl !== "string" || !rawUrl || rawUrl.length > 2048) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.origin || parsed.origin === "null") return null;
    return { url: parsed.href, origin: parsed.origin };
  } catch {
    return null;
  }
}

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return true;
  }
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * The subset of the `<webview>` tag's API this view uses. Declared locally
 * (rather than pulling in the full `Electron.WebviewTag` ambient type)
 * because the renderer doesn't otherwise depend on Electron's DOM typings.
 */
interface WebviewElement extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  clearHistory(): void;
  getURL(): string;
  getTitle(): string;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  reload(): void;
  stop(): void;
  send(channel: string, ...args: unknown[]): void;
}

/**
 * Payload of the `<webview>` `render-process-gone` DOM event in Electron 42.
 * Unlike the main-process `webContents` signal (which passes details as a
 * second argument), the guest DOM event nests them under `event.details`.
 */
interface RenderProcessGoneEventLike {
  details?: { reason?: string; exitCode?: number };
}

/** Payload of the `<webview>` `did-fail-load` DOM event (flat, per Electron 42). */
interface DidFailLoadEventLike {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

interface DidRedirectNavigationEventLike {
  url: string;
  isInPlace: boolean;
  isMainFrame: boolean;
}

type DidStartNavigationEventLike = DidRedirectNavigationEventLike;

/** net::ERR_ABORTED — emitted for cancelled/redirected navigations; not a real failure. */
const ERR_ABORTED = -3;
/** One automatic recovery attempt is scheduled this long after a hard crash. */
const AUTO_RECOVER_DELAY_MS = 300;
const PAGE_TITLE_MAX_UNITS = 500;

const DEFAULT_URL = "https://duckduckgo.com/";
const BOOTSTRAP_URL = "about:blank";

type WebPickState = PickState<WebViewerSelectionSnapshot, WebViewerFeedbackOutcome>;

/**
 * Electron reports committed navigation URLs in canonical browser form (for
 * example, a bare HTTP origin gains a trailing slash). Use that same identity
 * for scheduler bookkeeping without changing the URL assigned to the guest or
 * the canonical URL later reported by Electron to the visible/persisted state.
 */
function navigationKey(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function sameNavigation(url: string | null, other: string | null): boolean {
  if (url === null || other === null) return url === other;
  return navigationKey(url) === navigationKey(other);
}

/**
 * Web Viewer view (Obsidian core plugin compat, shipped in Obsidian 1.8.3):
 * an in-app browser tab hosting an Electron `<webview>`. `viewType`
 * "webviewer" and the `{ url }` state shape match Obsidian's Web Viewer, so
 * any plugin that targets that view type (e.g. the Threads plugin's
 * `obsidian_open_url`) Just Works against Geode too. See main.ts's
 * `webviewTag: true` and the `persist:webviewer` partition (its own,
 * cookie-jar-isolated session — the target for Chrome cookie import).
 */
export class WebView implements View, ReloadableView {
  readonly viewType = "webviewer";
  readonly reloadLabel = "Reload page";
  containerEl: HTMLElement;
  private webview: WebviewElement;
  private stageEl: HTMLElement;
  private overlayEl: HTMLElement;
  private selectionBoxEl: HTMLElement;
  private addressInput: HTMLInputElement;
  private backBtn: HTMLButtonElement;
  private forwardBtn: HTMLButtonElement;
  private reloadBtn: HTMLButtonElement;
  private pickBtn: HTMLButtonElement;
  private hoverEl: HTMLElement;
  private sentChipEl: HTMLElement;
  private errorEl: HTMLElement;
  // Assigned in buildErrorOverlay(), invoked from the constructor.
  private errorTitleEl!: HTMLElement;
  private errorDetailEl!: HTMLElement;
  private viewport: Viewport = { ...VIEWPORTS.fill };
  private currentUrl: string;
  /**
   * Origin-E committed main-frame HTTP(S) URL. Starts `null` on `about:blank`,
   * set only on main-frame `did-navigate` and `did-navigate-in-page` when
   * `parseHttpPageUrl` succeeds, and cleared immediately on cross-document
   * `did-start-navigation`, main-frame `did-fail-load`, or guest crash.
   */
  private committedHealthyUrl: string | null = null;
  /**
   * The URL of the most recent failed main-frame load, or null while the
   * guest is healthy. `did-navigate` deliberately does not fire on a failed
   * load, so `currentUrl` still points at the *previous* page after one:
   * reloading it would silently teleport the user backwards. This is the URL
   * a reload should actually retry.
   */
  private failedUrl: string | null = null;
  private title = "";
  private cleanups: (() => void)[] = [];
  /** The neutral guest exists synchronously; real navigation starts only once its guest API is ready. */
  private guestAttached = false;
  private guestCanLoadUrl = false;
  /** A terminated guest must be respawned with `src`; it cannot accept `loadURL`. */
  private guestDead = false;
  private bootstrapHistoryPending = true;
  private requestedUrl: string | null = null;
  private dispatchedUrl: string | null = null;
  private supersededUrls = new Set<string>();
  private activeNavigationUrls = new Set<string>();
  private activeNavigationStarted = false;
  /**
   * Per-URL single-shot guard: at most one automatic reload is attempted per
   * crash on a given page, so a genuinely broken/GPU-hostile page can't spin
   * up a reload loop. Reset only on a user-initiated reload or a new
   * navigation (`loadUrl`) — never on the auto-recovery path itself. Mirrors
   * main.ts's one-recovery `recoverRenderer` design.
   */
  private autoRecovered = false;
  /** De-dupes a single crash arriving via both `render-process-gone` and the legacy `crashed` alias. */
  private crashHandled = false;
  private recoverTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- Element picker (ADR 0056) ----
  private readonly viewSessionId: string;
  private bridge: WebViewerInspectorBridge | null = null;
  private pick: PickController<WebViewerSelectionSnapshot, WebViewerFeedbackOutcome> | null = null;
  private popover: PickPopover | null = null;
  private layoutObserver: ResizeObserver | undefined;
  private rectCoalescer: RectCoalescer<BoxRect> | null = null;
  private liveRect: BoxRect | null = null;
  private liveViewport: GuestViewport | null = null;
  private pendingViewport: GuestViewport | null = null;
  private earlyRect: BoxRect | null = null;
  private liveRectFor: WebViewerSelectionSnapshot | null = null;
  private pointerInPopover = false;
  private offscreen = false;
  private handlerName = "Agent Threads";
  private lastPickPhase: WebPickState["phase"] = "off";
  private lastSubmit: WebPickState["submit"] = "idle";
  private lastAcceptedOutcome: WebViewerFeedbackOutcome | null = null;
  private threadRequestToken = 0;
  private closed = false;

  constructor(
    private app: App,
    private leaf: WorkspaceLeaf
  ) {
    this.viewSessionId =
      typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : `wv_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
    this.currentUrl = DEFAULT_URL;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "web-view is-fill";

    const toolbar = document.createElement("div");
    toolbar.className = "web-view-toolbar";
    this.backBtn = this.makeButton("arrow-left", "Back", () => this.webview.goBack());
    this.forwardBtn = this.makeButton("arrow-right", "Forward", () => this.webview.goForward());
    // Every reload affordance goes through the action, so the button, the
    // error overlay, Cmd+R and the tab context menu can never drift apart.
    this.reloadBtn = this.makeButton("rotate-cw", "Reload", () => this.runReload());

    this.addressInput = document.createElement("input");
    this.addressInput.type = "text";
    this.addressInput.className = "web-view-address";
    this.addressInput.spellcheck = false;
    this.addressInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.navigate(this.addressInput.value.trim());
      }
    });

    const viewports = document.createElement("div");
    viewports.className = "web-view-viewports";
    viewports.setAttribute("role", "group");
    viewports.setAttribute("aria-label", "Viewport size");
    for (const preset of VIEWPORT_PRESET_ORDER) {
      const meta = VIEWPORT_CONTROLS[preset];
      const button = document.createElement("button");
      button.className = "clickable-icon web-view-viewport-btn";
      button.type = "button";
      button.dataset.viewportPreset = preset;
      button.title =
        preset === "fill"
          ? meta.label
          : `${meta.label} (${VIEWPORTS[preset].width} × ${VIEWPORTS[preset].height})`;
      button.setAttribute("aria-label", `${meta.label} viewport`);
      button.setAttribute("aria-pressed", String(preset === "fill"));
      if (preset === "fill") button.classList.add("is-active");
      setIcon(button, meta.icon);
      button.addEventListener("click", () => this.applyViewport(VIEWPORTS[preset], true));
      viewports.appendChild(button);
    }

    this.pickBtn = document.createElement("button");
    this.pickBtn.className = "clickable-icon web-view-toolbar-btn web-view-pick-btn";
    this.pickBtn.type = "button";
    this.pickBtn.title = "Pick element";
    this.pickBtn.setAttribute("aria-label", "Pick element");
    this.pickBtn.setAttribute("aria-pressed", "false");
    this.pickBtn.setAttribute("data-testid", "web-view-pick-btn");
    this.pickBtn.hidden = true;
    this.pickBtn.disabled = true;
    setIcon(this.pickBtn, "mouse-pointer-click");
    this.pickBtn.addEventListener("click", (event) => {
      this.togglePick(event.detail === 0 ? "keyboard" : "pointer");
    });

    this.hoverEl = document.createElement("span");
    this.hoverEl.className = "web-view-hover";
    this.hoverEl.hidden = true;

    this.sentChipEl = document.createElement("span");
    this.sentChipEl.className = "web-view-sent";
    this.sentChipEl.hidden = true;

    // Spec: Web Viewer address-bar three-dot menu → Bookmark. A single "More
    // options" affordance keeps room for future page actions. The items come
    // from App rather than from a direct actions.ts import: views compose
    // menus by asking App, the same way file-explorer.ts does.
    const moreBtn = this.makeButton("more-horizontal", "More options", (e) => {
      this.app.showMenu(e, this.app.webPageMenuItems(this), {
        anchor: moreBtn,
        horizontalAlign: "end",
      });
    });

    toolbar.appendChild(this.backBtn);
    toolbar.appendChild(this.forwardBtn);
    toolbar.appendChild(this.reloadBtn);
    toolbar.appendChild(this.addressInput);
    toolbar.appendChild(viewports);
    toolbar.appendChild(this.pickBtn);
    toolbar.appendChild(this.hoverEl);
    toolbar.appendChild(this.sentChipEl);
    toolbar.appendChild(moreBtn);
    this.containerEl.appendChild(toolbar);

    // The stage, picker overlay, and crash/error overlay share a positioned
    // body so `.web-view-overlay` (z-index: 5) tracks the stage while
    // `.web-view-error` (z-index: 10) covers everything below the toolbar.
    const body = document.createElement("div");
    body.className = "web-view-body";

    this.stageEl = document.createElement("div");
    this.stageEl.className = "web-view-stage";

    this.overlayEl = document.createElement("div");
    this.overlayEl.className = "web-view-overlay";
    this.selectionBoxEl = document.createElement("div");
    this.selectionBoxEl.className = "web-view-selection-box";
    this.selectionBoxEl.hidden = true;
    this.overlayEl.appendChild(this.selectionBoxEl);

    this.webview = document.createElement("webview") as unknown as WebviewElement;
    this.webview.classList.add("web-view-frame");
    this.webview.setAttribute("partition", "persist:webviewer");
    this.webview.setAttribute("allowpopups", "");
    this.webview.src = BOOTSTRAP_URL;
    this.errorEl = this.buildErrorOverlay();

    // `did-attach` can fire as the element is inserted. Install every guest
    // listener first so the queued real navigation cannot be missed.
    this.attachWebviewEvents();
    this.attachInspector();
    this.stageEl.appendChild(this.webview);
    body.appendChild(this.stageEl);
    body.appendChild(this.overlayEl);
    body.appendChild(this.errorEl);
    this.containerEl.appendChild(body);
    this.applyViewport(this.viewport, false);
  }

  /** Hidden-by-default error overlay shown on a guest crash or main-frame load failure. */
  private buildErrorOverlay(): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "web-view-error is-hidden";

    const icon = document.createElement("div");
    icon.className = "web-view-error-icon";
    setIcon(icon, "alert-triangle");

    this.errorTitleEl = document.createElement("div");
    this.errorTitleEl.className = "web-view-error-title";

    this.errorDetailEl = document.createElement("div");
    this.errorDetailEl.className = "web-view-error-detail";

    const reloadButton = document.createElement("button");
    reloadButton.className = "web-view-error-reload";
    reloadButton.textContent = "Reload";
    // Manual reload: reload() clears the single-shot guard so the user's
    // attempt gets its own fresh auto-recovery budget if it, too, crashes,
    // and retries the URL that actually failed rather than the last one that
    // committed.
    reloadButton.addEventListener("click", () => this.runReload());

    overlay.appendChild(icon);
    overlay.appendChild(this.errorTitleEl);
    overlay.appendChild(this.errorDetailEl);
    overlay.appendChild(reloadButton);
    return overlay;
  }

  /** Route a UI affordance through the action rather than calling reload() directly. */
  private runReload(): void {
    void this.app.actions.execute("web.reload", { reloadable: this, webView: this, leaf: this.leaf });
  }

  private makeButton(icon: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "web-view-toolbar-btn clickable-icon";
    btn.type = "button";
    btn.title = title;
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private applyViewport(viewport: Viewport, persist: boolean): void {
    this.viewport = { ...viewport };
    const fill = viewport.preset === "fill";
    this.webview.style.width = fill ? "100%" : `${viewport.width}px`;
    this.webview.style.height = fill ? "100%" : `${viewport.height}px`;
    this.containerEl.classList.toggle("is-fill", fill);
    for (const button of this.containerEl.querySelectorAll<HTMLElement>("[data-viewport-preset]")) {
      const active = button.dataset.viewportPreset === viewport.preset;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    this.repositionPick("layout");
    if (persist) this.persistState();
  }

  // --- Origin-E committed page verification & element picker ----------------

  /**
   * Returns the embedder-verified HTTP(S) `WebViewerPageTarget` for the healthy
   * main-frame document currently rendered in `<webview>`, or `null` when the
   * guest is on `about:blank`, a non-HTTP(S) scheme, mid-navigation, crashed,
   * or showing a failed-load overlay.
   */
  getHealthyPageTarget(): WebViewerPageTarget | null {
    if (!this.committedHealthyUrl || this.guestDead || this.crashHandled || this.failedUrl !== null) {
      return null;
    }
    const committed = parseHttpPageUrl(this.committedHealthyUrl);
    if (!committed) return null;
    let liveRaw = "";
    try {
      liveRaw = this.webview.getURL();
    } catch {
      return null;
    }
    if (!liveRaw) return null;
    const live = parseHttpPageUrl(liveRaw);
    if (!live || live.origin !== committed.origin) return null;
    const rawTitle = this.title || this.safeGetWebviewTitle();
    const title = cleanThreadLabel(rawTitle, PAGE_TITLE_MAX_UNITS);
    return {
      url: live.url,
      origin: committed.origin,
      title,
    };
  }

  private safeGetWebviewTitle(): string {
    try {
      return this.webview.getTitle() || "";
    } catch {
      return "";
    }
  }

  private clearCommittedHealthyUrl(): void {
    const hadUrl = this.committedHealthyUrl !== null;
    this.committedHealthyUrl = null;
    this.threadRequestToken++;
    this.pick?.forceExit();
    if (hadUrl || !this.pickBtn.hidden || !this.pickBtn.disabled) {
      this.updatePickAvailability();
    }
  }

  canTogglePick(): boolean {
    return !this.pickBtn.hidden && !this.pickBtn.disabled;
  }

  togglePick(via: "pointer" | "keyboard"): void {
    if (this.canTogglePick()) this.pick?.toggle(via);
  }

  private updatePickAvailability(): void {
    const service = this.app.webViewerFeedbackService;
    if (!service || !service.hasAnyHandler()) {
      this.pickBtn.hidden = true;
      this.pickBtn.disabled = true;
      this.pick?.setAvailable(false);
      return;
    }
    const target = this.getHealthyPageTarget();
    const available = target !== null && this.app.webViewerFeedback.has(target);
    if (target && available) {
      this.handlerName = service.describeHandler(target) ?? this.handlerName;
    }
    this.pickBtn.hidden = !available;
    this.pickBtn.disabled = !available;
    this.pick?.setAvailable(available);
  }

  private attachInspector(): void {
    const registry = this.app.webViewerFeedbackService;
    if (!registry || !this.app.webViewerFeedback) return;
    const bridge = new WebViewerInspectorBridge({
      webview: this.webview as unknown as InspectorWebview,
      viewSessionId: this.viewSessionId,
      registry,
      getPageTarget: () => this.getHealthyPageTarget(),
      getViewportPreset: () => this.viewport.preset,
      callbacks: {
        onHover: (hover) => this.showHover(hover),
        onSelect: (snapshot) => this.onElementSelected(snapshot),
        onCancel: () => {
          this.pick?.cancelFromGuest();
        },
        onRect: (report) => this.onGuestRect(report),
      },
    });

    const controller = new PickController<WebViewerSelectionSnapshot, WebViewerFeedbackOutcome>({
      setGuestMode: (mode) => bridge.setMode(mode),
      submit: async (snapshot, comment) => {
        const threadId = this.popover?.getSelectedThreadId();
        if (!threadId) {
          return {
            status: "rejected",
            reason: "invalid",
            message: "Choose a target thread before sending.",
            source: "invalid-result",
          };
        }
        return bridge.submit(snapshot, comment, threadId);
      },
      canSend: () => Boolean(this.popover?.getSelectedThreadId()),
      focus: (where) => this.focusPick(where),
      changed: (state) => this.renderPick(state),
    });

    const popover = new PickPopover(
      document,
      {
        onComment: (text) => controller.setComment(text),
        onSend: () => controller.send(),
        onCancel: () => {
          controller.cancel();
        },
        onDone: () => controller.done(),
        onEscape: () => {
          controller.escape();
        },
        onRepick: () => {
          controller.repick();
        },
      },
      {
        webViewer: {
          onThreadChange: () => controller.notifyChanged(),
          onRefreshThreads: () => {
            const page = this.getHealthyPageTarget() ?? this.pick?.state.snapshot?.page ?? null;
            if (page) void this.loadThreadsForPage(page, false);
          },
        },
      },
    );
    popover.el.hidden = true;
    document.body.appendChild(popover.el);

    this.rectCoalescer = createRectCoalescer({
      schedule: (cb) => window.requestAnimationFrame(cb),
      cancel: (h) => window.cancelAnimationFrame(h),
      apply: (box) => {
        if (this.pick?.state.phase === "popover") {
          this.liveRect = box;
          this.liveViewport = this.pendingViewport;
          this.repositionPick("rect");
        } else {
          this.earlyRect = box;
        }
      },
    });

    popover.el.addEventListener("mouseenter", () => {
      this.pointerInPopover = true;
    });
    popover.el.addEventListener("mouseleave", () => {
      this.pointerInPopover = false;
      this.repositionPick("settle");
    });
    popover.el.addEventListener("focusout", () => {
      window.setTimeout(() => this.repositionPick("settle"), 0);
    });

    if (typeof ResizeObserver !== "undefined") {
      this.layoutObserver = new ResizeObserver(() => this.repositionPick("layout"));
      this.layoutObserver.observe(this.containerEl);
      this.layoutObserver.observe(this.stageEl);
      this.layoutObserver.observe(this.webview);
      this.layoutObserver.observe(popover.el);
    }

    const onWindowResize = () => this.repositionPick("layout");
    const onStageScroll = () => this.repositionPick("layout");
    const onWindowKeydown = (event: KeyboardEvent) => this.onWindowKeydown(event);
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("keydown", onWindowKeydown);
    this.stageEl.addEventListener("scroll", onStageScroll, { passive: true });
    const unsubFeedback = this.app.webViewerFeedback.onDidChange(() => this.updatePickAvailability());
    const unsubLeaf = (this.app.workspace?.on?.("active-leaf-change", () => {
      this.repositionPick("layout");
    }) ?? undefined) as unknown as (() => void) | undefined;

    this.cleanups.push(
      () => window.removeEventListener("resize", onWindowResize),
      () => window.removeEventListener("keydown", onWindowKeydown),
      () => this.stageEl.removeEventListener("scroll", onStageScroll),
      () => unsubFeedback(),
      () => {
        try {
          unsubLeaf?.();
        } catch {
          /* workspace tearing down */
        }
      },
    );

    this.bridge = bridge;
    this.pick = controller;
    this.popover = popover;
    this.updatePickAvailability();
  }

  private detachInspector(): void {
    this.threadRequestToken++;
    this.layoutObserver?.disconnect();
    this.layoutObserver = undefined;
    this.rectCoalescer?.dispose();
    this.rectCoalescer = null;
    this.pick?.dispose();
    this.bridge?.dispose();
    this.popover?.dispose();
    this.popover?.el.remove();
    this.pick = null;
    this.bridge = null;
    this.popover = null;
    this.liveRect = null;
    this.liveViewport = null;
    this.pendingViewport = null;
    this.earlyRect = null;
    this.liveRectFor = null;
    this.pointerInPopover = false;
    this.offscreen = false;
  }

  private onElementSelected(snapshot: WebViewerSelectionSnapshot): void {
    if (this.closed || !this.pick || !this.popover) return;
    this.popover.setOrigin(snapshot.page.origin);
    this.popover.setThreadListState({ status: "loading", reset: true });
    this.pick.selected(snapshot, document.activeElement === this.webview ? "guest" : "toggle");
    void this.loadThreadsForPage(snapshot.page, false);
  }

  private async loadThreadsForPage(page: WebViewerPageTarget, reset: boolean): Promise<void> {
    if (!this.popover || this.closed) return;
    const token = ++this.threadRequestToken;
    this.popover.setThreadListState({ status: "loading", reset });
    const outcome = await this.app.webViewerFeedbackService.listThreads(page);
    if (this.closed || token !== this.threadRequestToken || !this.popover) return;
    if (outcome.status === "ok") {
      this.popover.setThreadListState({ status: "ready", list: outcome.value });
    } else {
      this.popover.setThreadListState({ status: "error", message: outcome.message });
    }
    this.repositionPick("layout");
  }

  private focusPick(where: FocusTarget): void {
    if (where === "toggle") this.pickBtn.focus();
    else if (where === "guest") this.webview.focus();
    else if (where === "comment") this.popover?.focusComment();
    else if (where === "done") this.popover?.focusDone();
  }

  private showHover(hover: InspectorHover): void {
    this.hoverEl.hidden = false;
    const text = hoverChipText(hover);
    if (this.hoverEl.textContent !== text) this.hoverEl.textContent = text;
    this.hoverEl.setAttribute("aria-live", hover.via === "keyboard" ? "polite" : "off");
  }

  private renderPick(state: WebPickState): void {
    const picking = state.phase !== "off";
    this.pickBtn.setAttribute("aria-pressed", String(picking));
    this.pickBtn.classList.toggle("is-active", picking);
    this.containerEl.classList.toggle("is-picking", picking);
    if (state.phase !== "pick") {
      this.hoverEl.hidden = true;
      this.hoverEl.textContent = "";
    }
    if (state.phase === "pick" && this.lastPickPhase === "off") {
      this.sentChipEl.hidden = true;
    }
    if (state.phase === "off" && this.lastPickPhase === "popover" && this.lastSubmit === "accepted") {
      this.showSentChip();
    }
    this.lastPickPhase = state.phase;
    this.lastSubmit = state.submit;
    if (state.submit === "accepted" && state.outcome) {
      this.lastAcceptedOutcome = state.outcome;
    }
    if (state.snapshot !== this.liveRectFor) {
      this.liveRectFor = state.snapshot;
      this.liveRect = state.snapshot ? this.earlyRect : null;
      this.liveViewport = this.liveRect ? this.pendingViewport : null;
      this.earlyRect = null;
      this.rectCoalescer?.reset();
      this.offscreen = false;
    }
    if (!state.snapshot) this.earlyRect = null;
    const popover = this.popover;
    if (!popover) return;
    popover.el.hidden = state.phase !== "popover";
    this.selectionBoxEl.hidden = state.phase !== "popover" || state.elementGone;
    if (state.phase === "popover") {
      popover.render(state, this.handlerName, { offscreen: this.offscreen });
      this.positionPopover(state, "layout");
    }
  }

  private showSentChip(): void {
    const chip = this.sentChipEl;
    const outcome = this.lastAcceptedOutcome;
    const queued = outcome?.status === "accepted" && outcome.delivery === "queued";
    chip.title = `Feedback ${queued ? "queued for" : "sent to"} ${this.handlerName}`;
    const icon = document.createElement("span");
    icon.className = "web-view-sent-icon";
    icon.setAttribute("aria-hidden", "true");
    setIcon(icon, "circle-check");
    const text = document.createElement("span");
    text.textContent = outcome?.message || (queued ? "Queued" : "Sent");
    chip.replaceChildren(icon, text);
    chip.hidden = false;
  }

  private onGuestRect(report: InspectRectMessage): void {
    if (report.target === "hover") {
      if (!report.connected || !report.rect) {
        this.hoverEl.hidden = true;
        this.hoverEl.textContent = "";
        return;
      }
      if (report.tag) this.showHover({ tag: report.tag, rect: report.rect, via: "pointer" });
      return;
    }
    if (!report.connected || !report.rect) {
      this.pick?.elementChanged();
      return;
    }
    this.pick?.elementReturned();
    this.pendingViewport = report.viewport ?? null;
    this.rectCoalescer?.push(report.rect);
  }

  private repositionPick(reason: "layout" | "rect" | "settle"): void {
    const state = this.pick?.state;
    if (state && state.phase === "popover") this.positionPopover(state, reason);
  }

  private positionPopover(state: WebPickState, reason: "layout" | "rect" | "settle"): void {
    const popover = this.popover;
    const snapshot = state.snapshot;
    if (!popover || !snapshot) return;
    const overlayRect = this.overlayEl.getBoundingClientRect();
    const showing =
      overlayRect.width > 0 &&
      overlayRect.height > 0 &&
      this.containerEl.getClientRects().length > 0 &&
      this.errorEl.classList.contains("is-hidden");
    popover.el.style.visibility = showing ? "" : "hidden";
    this.selectionBoxEl.style.visibility = showing ? "" : "hidden";
    if (!showing) return;

    const frame = this.webview.getBoundingClientRect();
    const box = this.liveRect ?? snapshot.selection.boundingBox.viewport;
    const origin = {
      left: frame.left,
      top: frame.top,
      clientLeft: this.webview.clientLeft,
      clientTop: this.webview.clientTop,
      clientWidth: this.webview.clientWidth,
      clientHeight: this.webview.clientHeight,
    };
    const guestViewport = (this.liveRect ? this.liveViewport : null) ?? snapshot.selection.viewport;
    const mapped = selectionBoxToStage(box, origin, overlayRect, guestViewport);
    this.selectionBoxEl.style.left = `${mapped.left}px`;
    this.selectionBoxEl.style.top = `${mapped.top}px`;
    this.selectionBoxEl.style.width = `${mapped.width}px`;
    this.selectionBoxEl.style.height = `${mapped.height}px`;

    const offscreen =
      !state.elementGone &&
      isElementOffscreen(
        {
          left: overlayRect.left + mapped.left,
          top: overlayRect.top + mapped.top,
          right: overlayRect.left + mapped.left + mapped.width,
          bottom: overlayRect.top + mapped.top + mapped.height,
        },
        {
          left: overlayRect.left,
          top: overlayRect.top,
          right: overlayRect.right,
          bottom: overlayRect.bottom,
        },
      );
    if (offscreen !== this.offscreen) {
      this.offscreen = offscreen;
      popover.render(state, this.handlerName, { offscreen });
    }

    const focusInside = popover.el.contains(document.activeElement);
    if (!shouldMovePopover({ reason, pointerInside: this.pointerInPopover, focusInside })) return;
    const win = { width: window.innerWidth, height: window.innerHeight };
    const bounds = choosePopoverBounds(overlayRect, win);
    popover.el.style.maxHeight = `${popoverMaxHeight(bounds)}px`;
    const size = {
      width: popover.el.offsetWidth,
      height: Math.min(popover.el.offsetHeight, popoverMaxHeight(bounds)),
    };
    const placed = popoverPosition(
      {
        x: overlayRect.left + mapped.left - bounds.left,
        y: overlayRect.top + mapped.top - bounds.top,
        width: mapped.width,
        height: mapped.height,
      },
      size,
      { width: bounds.width, height: bounds.height },
    );
    const final = clampIntoWindow(
      { left: bounds.left + placed.left, top: bounds.top + placed.top },
      size,
      win,
    );
    popover.el.style.left = `${Math.round(final.left)}px`;
    popover.el.style.top = `${Math.round(final.top)}px`;
  }

  private onWindowKeydown(event: KeyboardEvent): void {
    const pick = this.pick;
    if (!pick || pick.state.phase === "off" || event.defaultPrevented || event.isComposing) return;
    if (!this.containerEl.isConnected || this.containerEl.getClientRects().length === 0) return;
    if (isEditableElement(document.activeElement)) return;
    if (event.key === "Escape") {
      if (pick.escape()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (pick.state.phase !== "pick" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "[" || event.key === "]") {
      event.preventDefault();
      this.bridge?.sendKey(event.key === "[" ? "parent" : "child");
    }
  }

  // --- Guest WebView lifecycle ---------------------------------------------

  private attachWebviewEvents(): void {
    const onNavigate = (e: Event): string | null => {
      const url = (e as unknown as { url: string }).url;
      if (this.isBootstrapEvent(url)) return null;
      if (this.isSupersededUrl(url)) return null;
      this.requestedUrl = url;
      this.dispatchedUrl = url;
      this.supersededUrls.clear();
      this.activeNavigationUrls.clear();
      this.activeNavigationStarted = false;
      this.currentUrl = url;
      this.addressInput.value = url;
      if (this.bootstrapHistoryPending) {
        this.webview.clearHistory();
        this.bootstrapHistoryPending = false;
      }
      this.updateNavButtons();
      this.persistState();
      return url;
    };
    const onTitleUpdated = (e: Event) => {
      const url = this.webview.getURL();
      if (this.isBootstrapEvent(url) || this.isSupersededUrl(url)) return;
      this.title = (e as unknown as { title: string }).title;
      this.leaf.updateHeader();
      this.persistState();
    };
    // `did-navigate` is the reliable "guest is healthy again" signal: it fires
    // only on a committed main-frame navigation, and NOT on a failed load
    // (verified against Electron 42 — a failure emits did-fail-load then a
    // dom-ready for Chromium's error page, but never did-navigate). So the
    // overlay is cleared here and deliberately NOT in dom-ready, which would
    // otherwise hide the error the instant it was shown.
    const onNavigateSuccess = (e: Event) => {
      const url = onNavigate(e);
      if (url === null) return;
      this.clearError();
      this.committedHealthyUrl = parseHttpPageUrl(url)?.url ?? null;
      if (!this.committedHealthyUrl) this.pick?.forceExit();
      this.updatePickAvailability();
    };
    const onNavigateInPage = (e: Event) => {
      const detail = e as unknown as { url: string; isMainFrame?: boolean };
      if (detail.isMainFrame === false) return;
      const url = onNavigate(e);
      if (url === null) return;
      const parsed = parseHttpPageUrl(url);
      this.committedHealthyUrl = parsed?.url ?? null;
      if (!this.committedHealthyUrl) {
        this.pick?.forceExit();
      } else {
        this.pick?.pageReloaded();
      }
      this.updatePickAvailability();
    };
    const onAttach = () => {
      this.guestAttached = true;
    };
    const onStartNavigation = (e: Event) => {
      const { url, isInPlace, isMainFrame } = e as unknown as DidStartNavigationEventLike;
      if (this.isBootstrapEvent(url)) return;
      if (isMainFrame && !isInPlace) {
        if (!this.isSupersededUrl(url)) {
          this.clearCommittedHealthyUrl();
        }
        if (sameNavigation(url, this.dispatchedUrl)) {
          this.activeNavigationStarted = true;
          this.activeNavigationUrls = new Set([navigationKey(url)]);
        }
      }
    };
    const onRedirect = (e: Event) => {
      const { url, isInPlace, isMainFrame } = e as unknown as DidRedirectNavigationEventLike;
      if (this.isBootstrapEvent(url)) return;
      if (isMainFrame && !isInPlace && this.activeNavigationStarted) {
        this.activeNavigationUrls.add(navigationKey(url));
      }
    };
    const onDomReady = () => {
      // `did-attach` only means a guest exists. Electron's programmatic guest
      // methods (including loadURL) are legal once that guest emits dom-ready.
      // A crashed guest can recover on this same element without attaching
      // again, so every dom-ready re-arms the API and releases a newer target.
      this.guestAttached = true;
      this.guestCanLoadUrl = true;
      this.guestDead = false;
      if (this.requestedUrl !== null
        && !sameNavigation(this.dispatchedUrl, this.requestedUrl)) {
        this.dispatchNavigation(this.requestedUrl);
      }
      this.updateNavButtons();
      this.updatePickAvailability();
    };

    // Guest renderer died (crash, OOM, kill). Electron 42 nests the payload
    // under `event.details`.
    const onRenderProcessGone = (e: Event) => {
      const details = (e as unknown as RenderProcessGoneEventLike).details ?? {};
      this.handleGuestCrash(details.reason ?? "crashed", details.exitCode);
    };
    // Legacy alias some macOS/Electron builds still emit; the de-dupe guard in
    // handleGuestCrash keeps it from double-firing with render-process-gone.
    const onCrashed = () => this.handleGuestCrash("crashed", undefined);

    const onFailLoad = (e: Event) => {
      const { errorCode, errorDescription, validatedURL, isMainFrame } =
        e as unknown as DidFailLoadEventLike;
      // Only surface real, top-level failures. Sub-frame errors and ERR_ABORTED
      // (normal for cancelled/redirected navigations) must not flash an overlay.
      if (!isMainFrame) return;
      const failedUrl = validatedURL || this.webview.getURL();
      if (this.isBootstrapEvent(failedUrl)) return;
      if (this.isSupersededUrl(failedUrl)) return;
      if (errorCode === ERR_ABORTED) return;
      this.activeNavigationUrls.clear();
      this.activeNavigationStarted = false;
      this.failedUrl = failedUrl || this.currentUrl;
      this.clearCommittedHealthyUrl();
      this.showError(
        "This page failed to load",
        `${errorDescription || "Load failed"} (${this.failedUrl})`
      );
    };

    // The guest called `window.close()`. Detaching the leaf is the tab-hosting
    // equivalent of closing the window.
    const onGuestClose = () => {
      void this.leaf.detach().catch(() => { /* leaf already gone */ });
    };

    const onUnresponsive = () => this.containerEl.classList.add("is-web-view-unresponsive");
    const onResponsive = () => this.containerEl.classList.remove("is-web-view-unresponsive");

    this.webview.addEventListener("did-attach", onAttach);
    this.webview.addEventListener("did-start-navigation", onStartNavigation);
    this.webview.addEventListener("did-redirect-navigation", onRedirect);
    this.webview.addEventListener("did-navigate", onNavigateSuccess);
    this.webview.addEventListener("did-navigate-in-page", onNavigateInPage);
    this.webview.addEventListener("page-title-updated", onTitleUpdated);
    this.webview.addEventListener("dom-ready", onDomReady);
    this.webview.addEventListener("render-process-gone", onRenderProcessGone);
    this.webview.addEventListener("crashed", onCrashed);
    this.webview.addEventListener("did-fail-load", onFailLoad);
    this.webview.addEventListener("close", onGuestClose);
    this.webview.addEventListener("unresponsive", onUnresponsive);
    this.webview.addEventListener("responsive", onResponsive);
    this.cleanups.push(
      () => this.webview.removeEventListener("did-attach", onAttach),
      () => this.webview.removeEventListener("did-start-navigation", onStartNavigation),
      () => this.webview.removeEventListener("did-redirect-navigation", onRedirect),
      () => this.webview.removeEventListener("did-navigate", onNavigateSuccess),
      () => this.webview.removeEventListener("did-navigate-in-page", onNavigateInPage),
      () => this.webview.removeEventListener("page-title-updated", onTitleUpdated),
      () => this.webview.removeEventListener("dom-ready", onDomReady),
      () => this.webview.removeEventListener("render-process-gone", onRenderProcessGone),
      () => this.webview.removeEventListener("crashed", onCrashed),
      () => this.webview.removeEventListener("did-fail-load", onFailLoad),
      () => this.webview.removeEventListener("close", onGuestClose),
      () => this.webview.removeEventListener("unresponsive", onUnresponsive),
      () => this.webview.removeEventListener("responsive", onResponsive)
    );
  }

  /**
   * Handle a dead guest renderer: show the crash overlay and, on a hard
   * (non-clean) crash, attempt exactly one automatic reload per URL. If the
   * reload crashes again, the overlay stays up and no further reload is
   * attempted — never a loop.
   */
  private handleGuestCrash(reason: string, exitCode: number | undefined): void {
    if (this.crashHandled) return;
    this.crashHandled = true;
    this.guestCanLoadUrl = false;
    this.guestDead = true;
    this.dispatchedUrl = null;
    this.activeNavigationUrls.clear();
    this.activeNavigationStarted = false;
    this.clearCommittedHealthyUrl();

    const exit = exitCode !== undefined ? ` (exit code ${exitCode})` : "";
    this.showError("This page crashed", `${reason}${exit} at ${this.currentUrl}`);
    void this.explainResourceExhaustion(`${reason}${exit}`);

    if (reason !== "clean-exit" && !this.autoRecovered) {
      this.autoRecovered = true;
      this.clearRecoverTimer();
      this.recoverTimer = setTimeout(() => this.reloadCurrent(), AUTO_RECOVER_DELAY_MS);
    }
  }

  /**
   * Refine the crash overlay when file-descriptor exhaustion is the real
   * cause (see describeGuestCrashCause).
   */
  private async explainResourceExhaustion(summary: string): Promise<void> {
    const probe = window.geode?.getFdPressure;
    if (typeof probe !== "function") return;
    const message = describeGuestCrashCause(summary, await probe().catch(() => null));
    if (!message || !this.crashHandled) return;
    this.showError(message.title, message.detail);
  }

  private showError(title: string, detail: string): void {
    this.errorTitleEl.textContent = title;
    this.errorDetailEl.textContent = detail;
    this.errorEl.classList.remove("is-hidden");
    this.repositionPick("layout");
  }

  /** Hide the overlay and re-arm the crash de-dupe once the guest is healthy again. */
  private clearError(): void {
    this.crashHandled = false;
    this.failedUrl = null;
    this.errorEl.classList.add("is-hidden");
  }

  /**
   * What a reload should target: the URL that failed if one did, else the last
   * URL that committed. See `failedUrl`.
   */
  private get targetUrl(): string {
    return this.failedUrl ?? this.currentUrl;
  }

  reload(): void {
    if (this.crashHandled) {
      this.reloadCurrent(true);
      return;
    }
    this.autoRecovered = false;
    this.clearRecoverTimer();
    this.addressInput.value = this.targetUrl;
    this.webview.reload();
  }

  private clearRecoverTimer(): void {
    if (this.recoverTimer !== null) {
      clearTimeout(this.recoverTimer);
      this.recoverTimer = null;
    }
  }

  private reloadCurrent(resetGuard = false): void {
    const url = this.targetUrl;
    this.clearRecoverTimer();
    if (resetGuard) this.autoRecovered = false;
    this.crashHandled = false;
    this.errorEl.classList.add("is-hidden");
    this.clearCommittedHealthyUrl();
    this.requestedUrl = url;
    this.dispatchedUrl = url;
    this.guestCanLoadUrl = false;
    this.supersededUrls.clear();
    this.activeNavigationUrls = new Set([navigationKey(url)]);
    this.activeNavigationStarted = false;
    this.webview.src = url;
  }

  private updateNavButtons(): void {
    this.backBtn.classList.toggle("is-disabled", !this.webview.canGoBack());
    this.forwardBtn.classList.toggle("is-disabled", !this.webview.canGoForward());
  }

  /** Persist the current URL (and non-fill viewport) into the leaf's view state. */
  private persistState(): void {
    this.leaf.setPersistedState(this.getState());
    this.app.workspace.trigger("layout-change");
  }

  private navigate(input: string): void {
    if (!input) return;
    this.loadUrl(resolveWebInput(input, this.app.settings.webViewer.searchEngine));
  }

  private isSupersededUrl(url: string): boolean {
    const key = navigationKey(url);
    return !this.activeNavigationUrls.has(key)
      && !sameNavigation(this.requestedUrl, url)
      && this.supersededUrls.has(key);
  }

  private isBootstrapEvent(url: string): boolean {
    return this.bootstrapHistoryPending
      && sameNavigation(url, BOOTSTRAP_URL)
      && !sameNavigation(this.requestedUrl, BOOTSTRAP_URL);
  }

  /** Replace an attached guest's navigation immediately; never await the page. */
  private dispatchNavigation(url: string): void {
    this.dispatchedUrl = url;
    this.activeNavigationUrls = new Set([navigationKey(url)]);
    this.activeNavigationStarted = false;
    let navigation: Promise<void>;
    try {
      navigation = this.webview.loadURL(url);
    } catch {
      this.guestCanLoadUrl = false;
      this.dispatchedUrl = null;
      this.activeNavigationUrls.clear();
      return;
    }
    void navigation.catch(() => {
      // Main-frame failures are rendered from did-fail-load.
    });
  }

  /** Load a URL, used both on initial open (setState) and address-bar navigation. */
  loadUrl(url: string): void {
    if (this.requestedUrl !== null && !sameNavigation(this.requestedUrl, url)) {
      this.supersededUrls.add(navigationKey(this.requestedUrl));
      for (const activeUrl of this.activeNavigationUrls) {
        this.supersededUrls.add(activeUrl);
      }
    }
    if (!sameNavigation(this.committedHealthyUrl, url)) {
      this.clearCommittedHealthyUrl();
    }
    this.requestedUrl = url;
    this.currentUrl = url;
    this.addressInput.value = url;
    this.clearRecoverTimer();
    this.autoRecovered = false;
    this.crashHandled = false;
    this.failedUrl = null;
    this.errorEl.classList.add("is-hidden");
    if (this.guestDead) {
      this.dispatchedUrl = url;
      this.activeNavigationUrls = new Set([navigationKey(url)]);
      this.activeNavigationStarted = false;
      this.webview.src = url;
    } else if (this.guestAttached && this.guestCanLoadUrl) {
      this.dispatchNavigation(url);
    }
    this.persistState();
  }

  // --- View / state-round-trip ---------------------------------------------

  get pageTitle(): string {
    return this.title;
  }

  getDisplayText(): string {
    if (this.title) return this.title;
    try {
      return new URL(this.currentUrl).host || this.currentUrl;
    } catch {
      return this.currentUrl;
    }
  }

  getIcon(): string {
    return "globe";
  }

  /** Called by `WorkspaceLeaf.setViewState` after the view is mounted. */
  setState(state: WebViewState): void {
    this.applyViewport(normalizeViewport(state?.viewport), false);
    if (state?.url) {
      this.loadUrl(state.url);
    } else {
      this.persistState();
    }
  }

  getState(): WebViewState {
    if (this.viewport.preset === "fill") {
      return { url: this.currentUrl };
    }
    return { url: this.currentUrl, viewport: { ...this.viewport } };
  }

  onOpen(): void {}

  onClose(): void {
    this.closed = true;
    this.clearRecoverTimer();
    this.committedHealthyUrl = null;
    this.requestedUrl = null;
    this.dispatchedUrl = null;
    this.guestAttached = false;
    this.guestCanLoadUrl = false;
    this.guestDead = false;
    this.supersededUrls.clear();
    this.activeNavigationUrls.clear();
    this.activeNavigationStarted = false;
    this.detachInspector();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.webview.remove();
  }
}
