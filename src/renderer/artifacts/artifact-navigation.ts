/**
 * Back / forward / home for an artifact tab (ArtifactView).
 *
 * An artifact may link between its own pages (a design "variations" board links to variations/A/index.html and so on),
 * and the guest webview keeps a normal session history for them. This controller only reads that history and asks the
 * guest to move along it; it never decides what may load. The isolation rules are untouched: the guest's own
 * will-navigate / will-redirect / request filter (main process) still deny anything off the artifact, and "home" can
 * only ever load the entry URL the runtime registered for this view.
 *
 * Pure (no DOM, no Electron): it works on the small slice of the `<webview>` tag below, so it is unit-tested directly.
 */

/** The subset of the `<webview>` tag this controller uses. The history methods throw until the guest fired `dom-ready`. */
export interface NavigationWebview {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface NavigationState {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** True when the guest is anywhere other than the artifact's entry page. */
  readonly canGoHome: boolean;
  readonly url: string;
}

/** Everything that can change the history or the current page; each one re-reads the guest. */
const REFRESH_EVENTS = ["dom-ready", "did-navigate", "did-navigate-in-page", "did-finish-load", "did-stop-loading", "did-fail-load"] as const;

const DISABLED = (url: string): NavigationState => ({ canGoBack: false, canGoForward: false, canGoHome: false, url });

/** Normalises a URL for comparison (`http://localhost:3000` and `http://localhost:3000/` are one page); falls back to the raw text. */
function normalise(url: string): string {
  try { return new URL(url).href; } catch { return url; }
}

export class ArtifactNavigation {
  private current: NavigationState;
  private disposed = false;
  private readonly entry: string;
  private readonly listener = (): void => this.refresh();

  constructor(
    private readonly webview: NavigationWebview,
    entryUrl: string,
    private readonly onChange: (state: NavigationState) => void,
  ) {
    this.entry = normalise(entryUrl);
    this.current = DISABLED(entryUrl);
    for (const type of REFRESH_EVENTS) webview.addEventListener(type, this.listener);
    this.current = this.read();
  }

  get state(): NavigationState { return this.current; }

  /** Goes back one page. False (and no guest call) when there is nowhere to go. */
  back(): boolean {
    if (this.disposed || !this.current.canGoBack) return false;
    this.webview.goBack();
    this.refresh();
    return true;
  }

  forward(): boolean {
    if (this.disposed || !this.current.canGoForward) return false;
    this.webview.goForward();
    this.refresh();
    return true;
  }

  /** Returns to the entry page. It is a normal navigation, so Back returns to the page the user left. */
  home(): boolean {
    if (this.disposed || !this.current.canGoHome) return false;
    // A superseded load (ERR_ABORTED) or a denied one is not an error the user can act on; the guest's own events
    // (did-fail-load, did-navigate) already drive the state, which refresh() re-reads.
    void this.webview.loadURL(this.entry).catch(() => { /* reported through the guest's own events */ });
    this.refresh();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const type of REFRESH_EVENTS) this.webview.removeEventListener(type, this.listener);
    this.current = DISABLED(this.current.url);
  }

  private read(): NavigationState {
    try {
      const url = this.webview.getURL();
      return {
        canGoBack: this.webview.canGoBack(),
        canGoForward: this.webview.canGoForward(),
        canGoHome: normalise(url) !== this.entry,
        url,
      };
    } catch {
      // Before dom-ready, or after the guest was destroyed, the webview methods throw: nothing is navigable yet.
      return DISABLED(this.current.url);
    }
  }

  private refresh(): void {
    if (this.disposed) return;
    const next = this.read();
    const previous = this.current;
    if (next.canGoBack === previous.canGoBack && next.canGoForward === previous.canGoForward && next.canGoHome === previous.canGoHome && next.url === previous.url) return;
    this.current = next;
    this.onChange(next);
  }
}
