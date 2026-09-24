/**
 * The auto-updater's two safety decisions, tested without Electron
 * (docs/adr/0003-auto-update-mechanism.md):
 *
 *  - packaged builds update by default while development builds stay inert;
 *  - HTTPS-only validation of the `GEODE_UPDATE_FEED_URL` override, which is
 *    handed straight to `setFeedURL({provider: "generic", url})` on builds
 *    that carry no publisher-identity check.
 */

import { describe, expect, it } from "vitest";
import {
  UPDATE_FEED_URL_ENV,
  resolveAutoUpdateGate,
  resolveUpdateFeedUrl,
  resolveUpdaterState,
} from "../../src/main/update-config";

describe("resolveAutoUpdateGate — packaged builds are live by default", () => {
  it("is off when unpackaged", () => {
    const gate = resolveAutoUpdateGate({}, false);
    expect(gate.enabled).toBe(false);
    expect(gate.enabled === false && gate.reason).toContain("not packaged");
  });

  it("is on for a packaged build without an opt-in environment variable", () => {
    expect(resolveAutoUpdateGate({}, true)).toEqual({ enabled: true });
  });
});

describe("resolveUpdaterState — the single decision both entry points share", () => {
  it("is not live when the gate passes but the feed is rejected", () => {
    const state = resolveUpdaterState(
      { [UPDATE_FEED_URL_ENV]: "http://staging.internal/geode/" },
      true
    );
    expect(state.live).toBe(false);
    // gatePassed true ⇒ the singleton is reachable, so pin its defaults off.
    expect(state.live === false && state.gatePassed).toBe(true);
    expect(state.live === false && state.reason).toContain(UPDATE_FEED_URL_ENV);
    expect(state.live === false && state.reason).toContain("https:");
  });

  it("is live against the default feed when no override is set", () => {
    expect(resolveUpdaterState({}, true)).toEqual({ live: true, feed: { kind: "default" } });
  });

  it("is live against a validated https override", () => {
    expect(
      resolveUpdaterState({ [UPDATE_FEED_URL_ENV]: "https://u.example.com/" }, true)
    ).toEqual({ live: true, feed: { kind: "custom", url: "https://u.example.com/" } });
  });

  it("never reports the gate as passed when unpackaged", () => {
    const state = resolveUpdaterState({ [UPDATE_FEED_URL_ENV]: "http://nope/" }, false);
    expect(state.live === false && state.gatePassed).toBe(false);
  });
});

describe("resolveUpdateFeedUrl — HTTPS only (B4.2)", () => {
  it("falls back to the baked-in feed when unset or blank", () => {
    expect(resolveUpdateFeedUrl(undefined)).toEqual({ kind: "default" });
    expect(resolveUpdateFeedUrl("")).toEqual({ kind: "default" });
    expect(resolveUpdateFeedUrl("   ")).toEqual({ kind: "default" });
  });

  it("accepts an https URL", () => {
    expect(resolveUpdateFeedUrl("https://updates.example.com/geode/")).toEqual({
      kind: "custom",
      url: "https://updates.example.com/geode/",
    });
    expect(resolveUpdateFeedUrl("  https://updates.example.com/geode/  ")).toEqual({
      kind: "custom",
      url: "https://updates.example.com/geode/",
    });
  });

  it("rejects plaintext http", () => {
    const result = resolveUpdateFeedUrl("http://updates.example.com/geode/");
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.reason).toContain("https:");
  });

  it("rejects file:// and other non-https schemes", () => {
    for (const url of [
      "file:///tmp/fake-feed/",
      "ftp://updates.example.com/",
      "javascript:alert(1)",
      "data:text/yaml,version:9.9.9",
    ]) {
      expect(resolveUpdateFeedUrl(url).kind, url).toBe("invalid");
    }
  });

  it("rejects garbage that does not parse as a URL", () => {
    for (const url of ["not a url", "://nope", "updates.example.com"]) {
      const result = resolveUpdateFeedUrl(url);
      expect(result.kind, url).toBe("invalid");
    }
    expect(
      resolveUpdateFeedUrl("not a url").kind === "invalid" &&
        (resolveUpdateFeedUrl("not a url") as { reason: string }).reason
    ).toContain("parseable");
  });
});
