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
    this.apply(resolveWebViewerConfig(persisted ?? legacyOptions));
  }

  update(patch: Partial<WebViewerConfig>): Promise<void> {
    const operation = this.pendingUpdate.then(async () => {
      const next = resolveWebViewerConfig({ enabled: this.enabled, ...this.options, ...patch });
      await this.config.write("web-viewer", next);
      this.apply(next);
      await this.onChange(next);
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
