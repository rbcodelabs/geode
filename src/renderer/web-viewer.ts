import type { ConfigService } from "./host/contracts";

export interface WebViewerOptions {
  searchEngine: string;
  homeUrl: string;
  openLinksInApp: boolean;
}

export interface WebViewerConfig extends WebViewerOptions {
  enabled: boolean;
}

export const DEFAULT_WEB_VIEWER_OPTIONS: WebViewerOptions = {
  searchEngine: "https://duckduckgo.com/?q=",
  homeUrl: "https://duckduckgo.com/",
  openLinksInApp: false,
};

export class WebViewerUpdateError extends Error {
  readonly name = "WebViewerUpdateError";
  readonly compensationFailed: boolean;
  constructor(
    message: string,
    readonly persistenceCompensationFailed: boolean,
    readonly lifecycleCompensationFailed: boolean,
    readonly compensationErrors: { persistence?: unknown; lifecycle?: unknown },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.compensationFailed = persistenceCompensationFailed || lifecycleCompensationFailed;
  }
}

export function resolveWebViewerConfig(raw: unknown): WebViewerConfig {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const text = (key: keyof WebViewerOptions): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    searchEngine: text("searchEngine") ?? DEFAULT_WEB_VIEWER_OPTIONS.searchEngine,
    homeUrl: text("homeUrl") ?? DEFAULT_WEB_VIEWER_OPTIONS.homeUrl,
    openLinksInApp: typeof record.openLinksInApp === "boolean"
      ? record.openLinksInApp
      : DEFAULT_WEB_VIEWER_OPTIONS.openLinksInApp,
  };
}

export class WebViewerService {
  enabled = true;
  readonly options: WebViewerOptions = { ...DEFAULT_WEB_VIEWER_OPTIONS };
  private pendingUpdate: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: ConfigService,
    private readonly onChange: (config: WebViewerConfig) => void | Promise<void> = () => {},
  ) {}

  async load(legacyOptions?: Partial<WebViewerOptions>): Promise<void> {
    const persisted = await this.config.read("web-viewer");
    // Compatibility fallback, not an eager migration: old app.json options
    // remain live until the first Web Viewer update transaction materializes
    // the complete config in web-viewer.json.
    this.apply(resolveWebViewerConfig(persisted ?? legacyOptions));
  }

  update(patch: Partial<WebViewerConfig>): Promise<void> {
    const operation = this.pendingUpdate.then(async () => {
      const previous = resolveWebViewerConfig({ enabled: this.enabled, ...this.options });
      const next = resolveWebViewerConfig({ enabled: this.enabled, ...this.options, ...patch });
      await this.config.write("web-viewer", next);
      this.apply(next);
      try {
        await this.onChange(next);
      } catch (cause) {
        this.apply(previous);
        let persistenceCompensationError: unknown;
        let lifecycleCompensationError: unknown;
        try {
          await this.config.write("web-viewer", previous);
        } catch (error) {
          persistenceCompensationError = error;
        }
        try {
          await this.onChange(previous);
        } catch (error) {
          lifecycleCompensationError = error;
        }
        const persistenceCompensationFailed = persistenceCompensationError !== undefined;
        const lifecycleCompensationFailed = lifecycleCompensationError !== undefined;
        throw new WebViewerUpdateError(
          persistenceCompensationFailed || lifecycleCompensationFailed
            ? "Web Viewer lifecycle failed and rollback was incomplete. In-memory settings were restored; persisted state or the active viewer lifecycle may differ until Geode restarts."
            : "Web Viewer lifecycle failed. The previous settings were restored.",
          persistenceCompensationFailed,
          lifecycleCompensationFailed,
          { persistence: persistenceCompensationError, lifecycle: lifecycleCompensationError },
          { cause },
        );
      }
    });
    this.pendingUpdate = operation.catch(() => {});
    return operation;
  }

  private apply(config: WebViewerConfig): void {
    this.enabled = config.enabled;
    Object.assign(this.options, {
      searchEngine: config.searchEngine,
      homeUrl: config.homeUrl,
      openLinksInApp: config.openLinksInApp,
    });
  }
}
