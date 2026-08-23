import type { App } from "../app";
import type { View, WorkspaceLeaf } from "../workspace";
import { setIcon } from "../api/icons";

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

/** net::ERR_ABORTED — emitted for cancelled/redirected navigations; not a real failure. */
const ERR_ABORTED = -3;
/** One automatic recovery attempt is scheduled this long after a hard crash. */
const AUTO_RECOVER_DELAY_MS = 300;

const DEFAULT_URL = "https://duckduckgo.com/";

/**
 * Web Viewer view (Obsidian core plugin compat, shipped in Obsidian 1.8.3):
 * an in-app browser tab hosting an Electron `<webview>`. `viewType`
 * "webviewer" and the `{ url }` state shape match Obsidian's Web Viewer, so
 * any plugin that targets that view type (e.g. the Threads plugin's
 * `obsidian_open_url`) Just Works against Geode too. See main.ts's
 * `webviewTag: true` and the `persist:webviewer` partition (its own,
 * cookie-jar-isolated session — the target for Chrome cookie import).
 */
export class WebView implements View {
  readonly viewType = "webviewer";
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
  private title = "";
  private cleanups: (() => void)[] = [];
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
    this.reloadBtn = this.makeButton("rotate-cw", "Reload", () => this.webview.reload());

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
    body.appendChild(this.webview);

    this.errorEl = this.buildErrorOverlay();
    body.appendChild(this.errorEl);
    this.containerEl.appendChild(body);

    this.attachWebviewEvents();
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
    // Manual reload: clear the single-shot guard so the user's attempt gets its
    // own fresh auto-recovery budget if it, too, crashes.
    reloadButton.addEventListener("click", () => this.reloadCurrent(true));

    overlay.appendChild(icon);
    overlay.appendChild(this.errorTitleEl);
    overlay.appendChild(this.errorDetailEl);
    overlay.appendChild(reloadButton);
    return overlay;
  }

  private makeButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "web-view-toolbar-btn clickable-icon";
    btn.title = title;
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private attachWebviewEvents(): void {
    const onNavigate = (e: Event) => {
      const url = (e as unknown as { url: string }).url;
      this.currentUrl = url;
      this.addressInput.value = url;
      this.updateNavButtons();
      this.persistState();
    };
    const onTitleUpdated = (e: Event) => {
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
      onNavigate(e);
      this.clearError();
    };
    const onDomReady = () => this.updateNavButtons();

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
      if (!isMainFrame || errorCode === ERR_ABORTED) return;
      this.showError(
        "This page failed to load",
        `${errorDescription || "Load failed"} (${validatedURL || this.currentUrl})`
      );
    };

    const onUnresponsive = () => this.containerEl.classList.add("is-web-view-unresponsive");
    const onResponsive = () => this.containerEl.classList.remove("is-web-view-unresponsive");

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

    const exit = exitCode !== undefined ? ` (exit code ${exitCode})` : "";
    this.showError("This page crashed", `${reason}${exit} at ${this.currentUrl}`);

    if (reason !== "clean-exit" && !this.autoRecovered) {
      this.autoRecovered = true;
      this.clearRecoverTimer();
      this.recoverTimer = setTimeout(() => this.reloadCurrent(), AUTO_RECOVER_DELAY_MS);
    }
  }

  private showError(title: string, detail: string): void {
    this.errorTitleEl.textContent = title;
    this.errorDetailEl.textContent = detail;
    this.errorEl.classList.remove("is-hidden");
  }

  /** Hide the overlay and re-arm the crash de-dupe once the guest is healthy again. */
  private clearError(): void {
    this.crashHandled = false;
    this.errorEl.classList.add("is-hidden");
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
    this.clearRecoverTimer();
    if (resetGuard) this.autoRecovered = false;
    this.crashHandled = false;
    this.errorEl.classList.add("is-hidden");
    this.webview.src = this.currentUrl;
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

  /** Load a URL, used both on initial open (setState) and address-bar navigation. */
  loadUrl(url: string): void {
    this.currentUrl = url;
    this.addressInput.value = url;
    // A fresh navigation gets a clean recovery budget and no stale overlay.
    this.clearRecoverTimer();
    this.autoRecovered = false;
    this.crashHandled = false;
    this.errorEl.classList.add("is-hidden");
    this.webview.src = url;
    this.persistState();
  }

  // --- View / state-round-trip ---------------------------------------------

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
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.webview.remove();
  }
}
