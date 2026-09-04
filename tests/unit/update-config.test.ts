/**
 * The auto-updater's two safety decisions, tested without Electron
 * (docs/adr/0003-auto-update-mechanism.md):
 *
 *  - the explicit opt-in gate that keeps the feature OFF by default, so a
 *    packaged build can't ship an unverified `quitAndInstall()` path whose
 *    documented mitigation is unreachable;
 *  - HTTPS-only validation of the `GEODE_UPDATE_FEED_URL` override, which is
 *    handed straight to `setFeedURL({provider: "generic", url})` on builds
 *    that carry no publisher-identity check.
 */

import { describe, expect, it } from "vitest";
import {
  AUTO_UPDATE_OPT_IN_ENV,
  UPDATE_FEED_URL_ENV,
  isTruthyFlag,
  resolveAutoUpdateGate,
  resolveUpdateFeedUrl,
  resolveUpdaterState,
} from "../../src/main/update-config";

describe("resolveAutoUpdateGate — opt-in required (B4.1)", () => {
  it("is off in a packaged build when the opt-in is absent", () => {
    const gate = resolveAutoUpdateGate({}, true);
    expect(gate.enabled).toBe(false);
    expect(gate.enabled === false && gate.reason).toContain(AUTO_UPDATE_OPT_IN_ENV);
  });

  it("is off when the opt-in is present but not affirmative", () => {
    for (const value of ["", "0", "false", "no", "off", "maybe"]) {
      const gate = resolveAutoUpdateGate({ [AUTO_UPDATE_OPT_IN_ENV]: value }, true);
      expect(gate.enabled, `value=${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("is off when unpackaged even with the opt-in set", () => {
    const gate = resolveAutoUpdateGate({ [AUTO_UPDATE_OPT_IN_ENV]: "1" }, false);
    expect(gate.enabled).toBe(false);
    expect(gate.enabled === false && gate.reason).toContain("not packaged");
  });

  it("is on only when packaged AND explicitly opted in", () => {
    for (const value of ["1", "true", "TRUE", "yes", " on "]) {
      expect(
        resolveAutoUpdateGate({ [AUTO_UPDATE_OPT_IN_ENV]: value }, true).enabled,
        `value=${JSON.stringify(value)}`
      ).toBe(true);
    }
  });

  it("explains why it is off, so the log line is actionable", () => {
    const gate = resolveAutoUpdateGate({}, true);
    expect(gate.enabled === false && gate.reason).toMatch(/verified|ad-hoc/i);
  });
});

describe("resolveUpdaterState — the single decision both entry points share", () => {
  const optedIn = { [AUTO_UPDATE_OPT_IN_ENV]: "1" };

  it("is not live, and marks the gate as not passed, without the opt-in", () => {
    const state = resolveUpdaterState({}, true);
    expect(state.live).toBe(false);
    // gatePassed false ⇒ never touch the electron-updater singleton.
    expect(state.live === false && state.gatePassed).toBe(false);
  });

  it("is not live when the gate passes but the feed is rejected", () => {
    const state = resolveUpdaterState(
      { ...optedIn, [UPDATE_FEED_URL_ENV]: "http://staging.internal/geode/" },
      true
    );
    expect(state.live).toBe(false);
    // gatePassed true ⇒ the singleton is reachable, so pin its defaults off.
    expect(state.live === false && state.gatePassed).toBe(true);
    expect(state.live === false && state.reason).toContain(UPDATE_FEED_URL_ENV);
    expect(state.live === false && state.reason).toContain("https:");
  });

  it("is live against the default feed when no override is set", () => {
    expect(resolveUpdaterState(optedIn, true)).toEqual({ live: true, feed: { kind: "default" } });
  });

  it("is live against a validated https override", () => {
    expect(
      resolveUpdaterState({ ...optedIn, [UPDATE_FEED_URL_ENV]: "https://u.example.com/" }, true)
    ).toEqual({ live: true, feed: { kind: "custom", url: "https://u.example.com/" } });
  });

  it("never reports the gate as passed when unpackaged", () => {
    const state = resolveUpdaterState({ ...optedIn, [UPDATE_FEED_URL_ENV]: "http://nope/" }, false);
    expect(state.live === false && state.gatePassed).toBe(false);
  });
});

describe("isTruthyFlag", () => {
  it("treats only explicit affirmatives as true", () => {
    expect(isTruthyFlag(undefined)).toBe(false);
    expect(isTruthyFlag("")).toBe(false);
    expect(isTruthyFlag("0")).toBe(false);
    expect(isTruthyFlag("1")).toBe(true);
    expect(isTruthyFlag("Yes")).toBe(true);
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
