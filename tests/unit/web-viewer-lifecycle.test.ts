import { describe, expect, it, vi } from "vitest";
import { WebViewerService, resolveWebViewerConfig } from "../../src/renderer/web-viewer";

describe("resolveWebViewerConfig", () => {
  it("enables Web Viewer by default and validates each option", () => {
    expect(resolveWebViewerConfig(null)).toEqual({
      enabled: true,
      searchEngine: "https://duckduckgo.com/?q=",
      homeUrl: "https://duckduckgo.com/",
      openLinksInApp: false,
    });
    expect(resolveWebViewerConfig({ enabled: false, homeUrl: " https://example.com/ ", searchEngine: 2, openLinksInApp: true })).toEqual({
      enabled: false,
      searchEngine: "https://duckduckgo.com/?q=",
      homeUrl: "https://example.com/",
      openLinksInApp: true,
    });
  });
});

describe("WebViewerService", () => {
  it("retains stable options identity while loading and updating", async () => {
    const writes: unknown[] = [];
    const service = new WebViewerService({
      read: async () => ({ enabled: false, homeUrl: "https://example.com/" }),
      write: async (_name, value) => { writes.push(value); },
    });
    const options = service.options;
    await service.load();
    expect(service.enabled).toBe(false);
    expect(service.options).toBe(options);
    await service.update({ enabled: true, openLinksInApp: true });
    expect(service.options).toBe(options);
    expect(options).toEqual({ searchEngine: "https://duckduckgo.com/?q=", homeUrl: "https://example.com/", openLinksInApp: true });
    expect(writes).toEqual([{ enabled: true, searchEngine: "https://duckduckgo.com/?q=", homeUrl: "https://example.com/", openLinksInApp: true }]);
  });

  it("serializes updates and publishes only after persistence succeeds", async () => {
    const changed = vi.fn();
    const service = new WebViewerService({
      read: async () => null,
      write: async () => { throw new Error("disk full"); },
    }, changed);
    await service.load();
    await expect(service.update({ enabled: false })).rejects.toThrow("disk full");
    expect(service.enabled).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });
});
