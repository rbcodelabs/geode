import { describe, expect, it, vi } from "vitest";
import { WebViewerService, WebViewerUpdateError, resolveWebViewerConfig } from "../../src/renderer/web-viewer";

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

  it("compensates persistence and runtime when lifecycle publication fails", async () => {
    const writes: unknown[] = [];
    let calls = 0;
    const service = new WebViewerService({
      read: async () => null,
      write: async (_name, value) => { writes.push(value); },
    }, async () => {
      calls += 1;
      if (calls === 1) throw new Error("factory failure");
    });
    await service.load();

    await expect(service.update({ enabled: false })).rejects.toMatchObject({
      name: "WebViewerUpdateError",
      compensationFailed: false,
    });
    expect(service.enabled).toBe(true);
    expect(writes).toEqual([
      { enabled: false, searchEngine: "https://duckduckgo.com/?q=", homeUrl: "https://duckduckgo.com/", openLinksInApp: false },
      { enabled: true, searchEngine: "https://duckduckgo.com/?q=", homeUrl: "https://duckduckgo.com/", openLinksInApp: false },
    ]);
  });

  it("reports failed compensation and lets the next queued update proceed from restored runtime", async () => {
    const writes: unknown[] = [];
    let writeCount = 0;
    let changeCount = 0;
    const service = new WebViewerService({
      read: async () => null,
      write: async (_name, value) => {
        writeCount += 1;
        writes.push(value);
        if (writeCount === 2) throw new Error("rollback disk failure");
      },
    }, async () => {
      changeCount += 1;
      if (changeCount === 1) throw new Error("factory failure");
    });
    await service.load();

    const failed = service.update({ enabled: false });
    const recovered = service.update({ homeUrl: "https://example.com/home" });
    await expect(failed).rejects.toBeInstanceOf(WebViewerUpdateError);
    await expect(failed).rejects.toMatchObject({ compensationFailed: true });
    await expect(recovered).resolves.toBeUndefined();
    expect(service.enabled).toBe(true);
    expect(service.options.homeUrl).toBe("https://example.com/home");
    expect(writes.at(-1)).toEqual({
      enabled: true,
      searchEngine: "https://duckduckgo.com/?q=",
      homeUrl: "https://example.com/home",
      openLinksInApp: false,
    });
  });
});
