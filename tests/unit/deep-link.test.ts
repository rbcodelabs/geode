import { describe, expect, it, vi } from "vitest";
import {
  DeepLinkDispatcher,
  parseGeodeDeepLink,
  shouldClaimObsidianProtocol,
} from "../../src/main/deep-link";

describe("parseGeodeDeepLink", () => {
  it("parses geode actions and decoded query parameters", () => {
    expect(parseGeodeDeepLink("geode://gdocs-sync?event=auth_complete&state=a%20b")).toEqual({
      action: "gdocs-sync",
      params: { action: "gdocs-sync", event: "auth_complete", state: "a b" },
    });
  });

  /**
   * Hosted Obsidian plugins mint `obsidian://` links for their own
   * `registerObsidianProtocolHandler` actions — Claude Threads' mobile
   * pairing QR code is `obsidian://pair?roomId=…&relay=…`. Rejecting the
   * scheme here meant those links never reached a registered handler.
   */
  it("parses obsidian:// links with the same action/param shape", () => {
    expect(parseGeodeDeepLink("obsidian://pair?roomId=r1&relay=wss%3A%2F%2Fx.example")).toEqual({
      action: "pair",
      params: { action: "pair", roomId: "r1", relay: "wss://x.example" },
    });
  });

  it("accepts an upper-cased scheme, which URL normalizes", () => {
    expect(parseGeodeDeepLink("OBSIDIAN://pair?roomId=r1")?.action).toBe("pair");
  });

  it("rejects unrelated schemes and malformed links", () => {
    expect(parseGeodeDeepLink("logseq://gdocs-sync?state=x")).toBeNull();
    expect(parseGeodeDeepLink("https://example.com/pair")).toBeNull();
    expect(parseGeodeDeepLink("not a url")).toBeNull();
  });

  it("keeps the URI host as the reserved action parameter", () => {
    expect(parseGeodeDeepLink("geode://gdocs-sync?action=other")?.params.action).toBe("gdocs-sync");
  });
});

describe("shouldClaimObsidianProtocol", () => {
  it("claims the scheme when no application answers it", () => {
    expect(shouldClaimObsidianProtocol("")).toBe(true);
    expect(shouldClaimObsidianProtocol("   ")).toBe(true);
  });

  it("re-claims when Geode is already the handler", () => {
    expect(shouldClaimObsidianProtocol("Geode")).toBe(true);
    expect(shouldClaimObsidianProtocol("Geode.app")).toBe(true);
  });

  it("does not hijack a real Obsidian install", () => {
    expect(shouldClaimObsidianProtocol("Obsidian")).toBe(false);
    expect(shouldClaimObsidianProtocol("Obsidian.app")).toBe(false);
  });

  it("takes the scheme over only when the user explicitly forces it", () => {
    expect(shouldClaimObsidianProtocol("Obsidian", true)).toBe(true);
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

  /**
   * Windows and Linux hand the launching URL through argv rather than
   * `open-url`, so argv scanning has to recognise every accepted scheme.
   */
  it("finds either scheme in argv, ignoring unrelated arguments", () => {
    const send = vi.fn();
    const dispatcher = new DeepLinkDispatcher();
    dispatcher.attach(send);

    expect(dispatcher.acceptArgv(["geode.exe", "--flag", "obsidian://pair?roomId=r1"])).toBe(true);
    expect(send).toHaveBeenLastCalledWith({
      action: "pair",
      params: { action: "pair", roomId: "r1" },
    });

    expect(dispatcher.acceptArgv(["geode.exe", "geode://gdocs-sync?state=argv"])).toBe(true);
    expect(dispatcher.acceptArgv(["geode.exe", "--flag", "/some/file.md"])).toBe(false);
  });
});
