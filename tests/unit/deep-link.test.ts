import { describe, expect, it, vi } from "vitest";
import { DeepLinkDispatcher, parseGeodeDeepLink } from "../../src/main/deep-link";

describe("parseGeodeDeepLink", () => {
  it("parses geode actions and decoded query parameters", () => {
    expect(parseGeodeDeepLink("geode://gdocs-sync?event=auth_complete&state=a%20b")).toEqual({
      action: "gdocs-sync",
      params: { action: "gdocs-sync", event: "auth_complete", state: "a b" },
    });
  });

  it("rejects non-Geode and malformed links", () => {
    expect(parseGeodeDeepLink("obsidian://gdocs-sync?state=x")).toBeNull();
    expect(parseGeodeDeepLink("not a url")).toBeNull();
  });

  it("keeps the URI host as the reserved action parameter", () => {
    expect(parseGeodeDeepLink("geode://gdocs-sync?action=other")?.params.action).toBe("gdocs-sync");
  });
});

describe("DeepLinkDispatcher", () => {
  it("queues a cold-start link until a renderer is ready", () => {
    const send = vi.fn();
    const dispatcher = new DeepLinkDispatcher();
    dispatcher.accept("geode://gdocs-sync?state=cold");
    dispatcher.attach(send);
    expect(send).toHaveBeenCalledWith({
      action: "gdocs-sync",
      params: { action: "gdocs-sync", state: "cold" },
    });
  });

  it("dispatches links received while the app is already running", () => {
    const send = vi.fn();
    const dispatcher = new DeepLinkDispatcher();
    dispatcher.attach(send);
    dispatcher.accept("geode://gdocs-sync?state=running");
    expect(send).toHaveBeenCalledWith({
      action: "gdocs-sync",
      params: { action: "gdocs-sync", state: "running" },
    });
  });
});
