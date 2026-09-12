import type { App } from "../app";
import type { ReloadableView, View, WorkspaceLeaf } from "../workspace";
import { setIcon } from "../api/icons";
import { describeGuestCrashCause } from "./web-view-crash-message";

/** State shape matches Obsidian's Web Viewer exactly, so `leaf.setViewState({ type: "webviewer", state: { url } })` from any hosted plugin (e.g. Threads' `obsidian_open_url`) works unmodified. */
export interface WebViewState {
  url: string;
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

const DEFAULT_URL = "https://duckduckgo.com/";
const BOOTSTRAP_URL = "about:blank";

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
  private addressInput: HTMLInputElement;
  private backBtn: HTMLButtonElement;
  private forwardBtn: HTMLButtonElement;
  private reloadBtn: HTMLButtonElement;
  private errorEl: HTMLElement;
  // Assigned in buildErrorOverlay(), invoked from the constructor.
  private errorTitleEl!: HTMLElement;
  private errorDetailEl!: HTMLElement;
  private currentUrl: string;
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

  constructor(
    private app: App,
    private leaf: WorkspaceLeaf
  ) {
    this.currentUrl = DEFAULT_URL;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "web-view";

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

    toolbar.appendChild(this.backBtn);
    toolbar.appendChild(this.forwardBtn);
    toolbar.appendChild(this.reloadBtn);
    toolbar.appendChild(this.addressInput);
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
    toolbar.appendChild(moreBtn);
    this.containerEl.appendChild(toolbar);

    // The frame and the error overlay share a positioned body so the overlay
    // covers only the (possibly dead-gray) frame surface while the toolbar —
    // including the address bar used to recover — stays interactive.
    const body = document.createElement("div");
    body.className = "web-view-body";

    this.webview = document.createElement("webview") as unknown as WebviewElement;
    this.webview.classList.add("web-view-frame");
    this.webview.setAttribute("partition", "persist:webviewer");
    this.webview.setAttribute("allowpopups", "");
    this.webview.src = BOOTSTRAP_URL;
    this.errorEl = this.buildErrorOverlay();

    // `did-attach` can fire as the element is inserted. Install every guest
    // listener first so the queued real navigation cannot be missed.
    this.attachWebviewEvents();
    body.appendChild(this.webview);
    body.appendChild(this.errorEl);
    this.containerEl.appendChild(body);
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
    btn.title = title;
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private attachWebviewEvents(): void {
    const onNavigate = (e: Event): boolean => {
      const url = (e as unknown as { url: string }).url;
      if (this.isBootstrapEvent(url)) return false;
      if (this.isSupersededUrl(url)) return false;
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
      return true;
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
      if (onNavigate(e)) this.clearError();
    };
    const onAttach = () => {
      this.guestAttached = true;
    };
    const onStartNavigation = (e: Event) => {
      const { url, isInPlace, isMainFrame } = e as unknown as DidStartNavigationEventLike;
      if (this.isBootstrapEvent(url)) return;
      if (isMainFrame && !isInPlace && sameNavigation(url, this.dispatchedUrl)) {
        this.activeNavigationStarted = true;
        this.activeNavigationUrls = new Set([navigationKey(url)]);
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
      this.showError(
        "This page failed to load",
        `${errorDescription || "Load failed"} (${this.failedUrl})`
      );
    };

    const onUnresponsive = () => this.containerEl.classList.add("is-web-view-unresponsive");
    const onResponsive = () => this.containerEl.classList.remove("is-web-view-unresponsive");

    this.webview.addEventListener("did-attach", onAttach);
    this.webview.addEventListener("did-start-navigation", onStartNavigation);
    this.webview.addEventListener("did-redirect-navigation", onRedirect);
    this.webview.addEventListener("did-navigate", onNavigateSuccess);
    this.webview.addEventListener("did-navigate-in-page", onNavigate);
    this.webview.addEventListener("page-title-updated", onTitleUpdated);
    this.webview.addEventListener("dom-ready", onDomReady);
    this.webview.addEventListener("render-process-gone", onRenderProcessGone);
    this.webview.addEventListener("crashed", onCrashed);
    this.webview.addEventListener("did-fail-load", onFailLoad);
    this.webview.addEventListener("unresponsive", onUnresponsive);
    this.webview.addEventListener("responsive", onResponsive);
    this.cleanups.push(
      () => this.webview.removeEventListener("did-attach", onAttach),
      () => this.webview.removeEventListener("did-start-navigation", onStartNavigation),
      () => this.webview.removeEventListener("did-redirect-navigation", onRedirect),
      () => this.webview.removeEventListener("did-navigate", onNavigateSuccess),
      () => this.webview.removeEventListener("did-navigate-in-page", onNavigate),
      () => this.webview.removeEventListener("page-title-updated", onTitleUpdated),
      () => this.webview.removeEventListener("dom-ready", onDomReady),
      () => this.webview.removeEventListener("render-process-gone", onRenderProcessGone),
      () => this.webview.removeEventListener("crashed", onCrashed),
      () => this.webview.removeEventListener("did-fail-load", onFailLoad),
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
   * cause (see describeGuestCrashCause). Best effort and deliberately after
   * the fact: the generic overlay is shown first so the user is never left
   * staring at nothing while the probe resolves.
   */
  private async explainResourceExhaustion(summary: string): Promise<void> {
    const probe = window.geode?.getFdPressure;
    if (typeof probe !== "function") return;
    const message = describeGuestCrashCause(summary, await probe().catch(() => null));
    // A reload (manual or automatic) may have cleared the overlay while the
    // probe was in flight; do not resurrect it.
    if (!message || !this.crashHandled) return;
    this.showError(message.title, message.detail);
  }

  private showError(title: string, detail: string): void {
    this.errorTitleEl.textContent = title;
    this.errorDetailEl.textContent = detail;
    this.errorEl.classList.remove("is-hidden");
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

  /**
   * User-initiated reload, driving the toolbar button, the error overlay's
   * Reload, the tab context menu and Cmd+R (`web.reload`).
   *
   * Deliberately not `reloadCurrent()`: that assigns `src`, which is a
   * browser-initiated *navigation*. Whether Chromium collapses it into a
   * reload is version-dependent, so history state and POST resubmission are
   * not guaranteed to behave — and on a never-navigated view `currentUrl` is
   * still the default home page, so it would navigate somewhere the user
   * never was. A real `reload()` has none of those problems. The one case
   * that genuinely needs a respawn is a dead guest, handled first.
   */
  reload(): void {
    if (this.crashHandled) {
      // A crashed guest WebContents is not reliably reusable, so rebuild it.
      this.reloadCurrent(true);
      return;
    }
    // The user's attempt gets its own fresh auto-recovery budget.
    this.autoRecovered = false;
    this.clearRecoverTimer();
    // Discard uncommitted address-bar typing: this is "reload what I'm
    // looking at", not "go to what I half-typed".
    this.addressInput.value = this.targetUrl;
    this.webview.reload();
  }

  private clearRecoverTimer(): void {
    if (this.recoverTimer !== null) {
      clearTimeout(this.recoverTimer);
      this.recoverTimer = null;
    }
  }

  /**
   * Respawn the current page. A crashed guest WebContents isn't reliably
   * reusable across every Electron/macOS build, so a fresh `src` assignment
   * (which builds a new guest) is used rather than `reload()` — same reasoning
   * as main.ts's "crashed WebContents is not reliably reusable" window replace.
   *
   * @param resetGuard true only for user-initiated reloads, which get a fresh
   *   single-shot auto-recovery budget. The automatic-recovery path passes
   *   false so it can't re-arm itself into a loop.
   */
  private reloadCurrent(resetGuard = false): void {
    // Read before the state reset below: this is the URL being respawned.
    const url = this.targetUrl;
    this.clearRecoverTimer();
    if (resetGuard) this.autoRecovered = false;
    this.crashHandled = false;
    this.errorEl.classList.add("is-hidden");
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

  /** Persist the current URL into the leaf's view state so session restore reopens to the same page, not just the URL the tab was first opened with. */
  private persistState(): void {
    this.leaf.setPersistedState({ url: this.currentUrl });
    this.app.workspace.trigger("layout-change");
  }

  private navigate(input: string): void {
    if (!input) return;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
      ? input
      : /^[^\s/]+\.[^\s/]+/.test(input)
        ? `https://${input}`
        : `${this.app.settings.webViewer.searchEngine}${encodeURIComponent(input)}`;
    this.loadUrl(url);
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
      // A guest may disappear between a readiness event and this call. Leave
      // the latest request queued for the recovered guest's next dom-ready.
      this.guestCanLoadUrl = false;
      this.dispatchedUrl = null;
      this.activeNavigationUrls.clear();
      return;
    }
    void navigation.catch(() => {
      // Main-frame failures are rendered from did-fail-load. Cancellation of
      // a superseded request also rejects this promise and is intentionally
      // silent here.
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
    this.requestedUrl = url;
    this.currentUrl = url;
    this.addressInput.value = url;
    // A fresh navigation gets a clean recovery budget and no stale overlay.
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

  /**
   * The page's own `<title>`, empty until one arrives. Deliberately not
   * `getDisplayText()`, which falls back to the URL host: a bookmark made
   * before the title lands should read as the URL, not as "example.com".
   */
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
    if (state?.url) this.loadUrl(state.url);
  }

  getState(): WebViewState {
    return { url: this.currentUrl };
  }

  onOpen(): void {}

  onClose(): void {
    this.clearRecoverTimer();
    this.requestedUrl = null;
    this.dispatchedUrl = null;
    this.guestAttached = false;
    this.guestCanLoadUrl = false;
    this.guestDead = false;
    this.supersededUrls.clear();
    this.activeNavigationUrls.clear();
    this.activeNavigationStarted = false;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.webview.remove();
  }
}
