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
  private currentUrl: string;
  private title = "";
  private cleanups: (() => void)[] = [];

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

    this.webview = document.createElement("webview") as unknown as WebviewElement;
    this.webview.classList.add("web-view-frame");
    this.webview.setAttribute("partition", "persist:webviewer");
    this.webview.setAttribute("allowpopups", "");
    this.containerEl.appendChild(this.webview);

    this.attachWebviewEvents();
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
    const onDomReady = () => this.updateNavButtons();

    this.webview.addEventListener("did-navigate", onNavigate);
    this.webview.addEventListener("did-navigate-in-page", onNavigate);
    this.webview.addEventListener("page-title-updated", onTitleUpdated);
    this.webview.addEventListener("dom-ready", onDomReady);
    this.cleanups.push(
      () => this.webview.removeEventListener("did-navigate", onNavigate),
      () => this.webview.removeEventListener("did-navigate-in-page", onNavigate),
      () => this.webview.removeEventListener("page-title-updated", onTitleUpdated),
      () => this.webview.removeEventListener("dom-ready", onDomReady)
    );
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
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.webview.remove();
  }
}
