import { describe, expect, it } from "vitest";
import {
  addMissingClientHints,
  chromiumMajor,
  guestClientHints,
  normalizeGuestUserAgent,
  secChUaPlatform,
} from "../../src/main/guest-fingerprint";

/**
 * The real Electron 42.4.0 / Chromium 148 default, measured from
 * `app.userAgentFallback` in this app. Every expectation below is anchored to it
 * so a regression in the strip shows up as a concrete string diff.
 *
 * Note both embedder tokens, and their positions: Electron injects
 * `app.getName()/app.getVersion()` *before* the Chrome token (lowercase in dev,
 * since it comes from package.json `name`) and `Electron/<ver>` after it.
 */
const ELECTRON_DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "geode/0.22.2 Chrome/148.0.7778.254 Electron/42.4.0 Safari/537.36";

/** What stock Chromium 148 on macOS actually sends. */
const STOCK_CHROMIUM_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/148.0.7778.254 Safari/537.36";

describe("normalizeGuestUserAgent", () => {
  it("strips both embedder tokens, leaving a stock Chromium UA", () => {
    expect(normalizeGuestUserAgent(ELECTRON_DEFAULT_UA, "geode")).toBe(STOCK_CHROMIUM_UA);
  });

  it("keeps the Chrome token, which stock Chromium legitimately sends", () => {
    // The fix is to stop claiming to be an embedder, not to stop claiming to be
    // the browser engine we actually are.
    expect(normalizeGuestUserAgent(ELECTRON_DEFAULT_UA, "geode")).toContain("Chrome/148.0.7778.254");
  });

  it("matches the product token case-insensitively", () => {
    // Dev builds report "geode" (package.json name); packaged builds report
    // "Geode" (electron-builder productName). Both must be stripped.
    expect(normalizeGuestUserAgent(ELECTRON_DEFAULT_UA, "Geode")).toBe(STOCK_CHROMIUM_UA);
    const packaged = ELECTRON_DEFAULT_UA.replace("geode/", "Geode/");
    expect(normalizeGuestUserAgent(packaged, "geode")).toBe(STOCK_CHROMIUM_UA);
  });

  it("strips a Geode token even when no product name is supplied", () => {
    const normalized = normalizeGuestUserAgent(ELECTRON_DEFAULT_UA);
    expect(normalized).not.toMatch(/Electron\//i);
    expect(normalized).not.toMatch(/geode\//i);
  });

  it("survives a product name containing regex metacharacters", () => {
    const ua = "Mozilla/5.0 Geode (v2)/1.0.0 Chrome/148.0.0.0 Safari/537.36";
    expect(normalizeGuestUserAgent(ua, "Geode (v2)")).toBe("Mozilla/5.0 Chrome/148.0.0.0 Safari/537.36");
  });

  it("collapses the whitespace a strip would otherwise leave behind", () => {
    const doubled = "Mozilla/5.0 Electron/42.4.0 Geode/1.0.0 Safari/537.36";
    expect(normalizeGuestUserAgent(doubled)).toBe("Mozilla/5.0 Safari/537.36");
  });

  it("is idempotent, so re-applying it on an already-clean UA is a no-op", () => {
    const once = normalizeGuestUserAgent(ELECTRON_DEFAULT_UA, "geode");
    expect(normalizeGuestUserAgent(once, "geode")).toBe(once);
  });

  it("leaves a UA with no embedder token untouched", () => {
    const stock =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/148.0.7778.254 Safari/537.36";
    expect(normalizeGuestUserAgent(stock, "geode")).toBe(stock);
  });

  it("ignores a blank product name rather than building a catch-all regex", () => {
    // An empty name must not turn into /\s+\/[\d.]+/ and eat real tokens.
    expect(normalizeGuestUserAgent(STOCK_CHROMIUM_UA, "")).toBe(STOCK_CHROMIUM_UA);
    expect(normalizeGuestUserAgent(STOCK_CHROMIUM_UA, "   ")).toBe(STOCK_CHROMIUM_UA);
  });
});

describe("chromiumMajor", () => {
  it("takes the major from a full Chromium version", () => {
    expect(chromiumMajor("148.0.7778.254")).toBe("148");
  });

  it("returns null for anything it cannot parse, rather than guessing", () => {
    expect(chromiumMajor("")).toBe(null);
    expect(chromiumMajor("unknown")).toBe(null);
    expect(chromiumMajor(undefined as unknown as string)).toBe(null);
  });
});

describe("secChUaPlatform", () => {
  it("maps the platforms Geode ships on to their UA-CH spec names", () => {
    expect(secChUaPlatform("darwin")).toBe("macOS");
    expect(secChUaPlatform("win32")).toBe("Windows");
    expect(secChUaPlatform("linux")).toBe("Linux");
  });

  it('falls back to the spec\'s "Unknown" rather than inventing a name', () => {
    expect(secChUaPlatform("freebsd")).toBe("Unknown");
  });
});

describe("guestClientHints", () => {
  it("derives the full hint set from the running Chromium and platform", () => {
    expect(guestClientHints("148.0.7778.254", "darwin")).toEqual({
      "Sec-CH-UA": '"Not/A)Brand";v="99", "Chromium";v="148"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"macOS"',
    });
  });

  it("tracks the Chromium major instead of hardcoding it", () => {
    const next = guestClientHints("149.0.1.2", "win32");
    expect(next?.["Sec-CH-UA"]).toBe('"Not/A)Brand";v="99", "Chromium";v="149"');
    expect(next?.["Sec-CH-UA-Platform"]).toBe('"Windows"');
  });

  it("claims no brand Chromium does not report, so the header matches navigator.userAgentData", () => {
    // navigator.userAgentData.brands is [{Not/A)Brand,99},{Chromium,<major>}]
    // and cannot be overridden from the host. Forging "Google Chrome" here
    // would make the header contradict the JS surface — worse than sending
    // nothing. tests/e2e/webview-fingerprint.spec.ts pins the match.
    expect(guestClientHints("148.0.7778.254", "darwin")?.["Sec-CH-UA"]).not.toContain("Google Chrome");
  });

  it("emits nothing at all when the Chromium version is unreadable", () => {
    // An unparseable version means we cannot state a truthful brand version.
    // Sending a partial or wrong hint set is worse than sending none.
    expect(guestClientHints("", "darwin")).toBe(null);
  });
});

describe("addMissingClientHints", () => {
  const hints = guestClientHints("148.0.7778.254", "darwin")!;

  it("adds all three hints when the request carries none", () => {
    const merged = addMissingClientHints({ Accept: "*/*" }, hints);
    expect(merged).toEqual({
      Accept: "*/*",
      "Sec-CH-UA": '"Not/A)Brand";v="99", "Chromium";v="148"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"macOS"',
    });
  });

  it("never overwrites a hint Chromium already sent", () => {
    // Future-proofing: if a later Electron starts sending these natively, ours
    // must yield rather than duplicate or fight it.
    const merged = addMissingClientHints(
      { "Sec-CH-UA": '"Chromium";v="999"', "Sec-CH-UA-Mobile": "?0", "Sec-CH-UA-Platform": '"macOS"' },
      hints,
    );
    expect(merged).toBe(null);
  });

  it("matches existing hints case-insensitively, as HTTP header names are", () => {
    const merged = addMissingClientHints({ "sec-ch-ua": '"Chromium";v="999"' }, hints);
    expect(merged).not.toBe(null);
    expect(merged!["sec-ch-ua"]).toBe('"Chromium";v="999"');
    expect(merged!["Sec-CH-UA"]).toBeUndefined();
    // The two it did not send are still filled in.
    expect(merged!["Sec-CH-UA-Mobile"]).toBe("?0");
    expect(merged!["Sec-CH-UA-Platform"]).toBe('"macOS"');
  });

  it("returns null when there is nothing to add, so the request is left alone", () => {
    expect(addMissingClientHints({ "Sec-CH-UA": "x", "Sec-CH-UA-Mobile": "?0", "Sec-CH-UA-Platform": '"macOS"' }, hints))
      .toBe(null);
  });

  it("does not mutate the headers object it was handed", () => {
    const original: Record<string, string> = { Accept: "*/*" };
    addMissingClientHints(original, hints);
    expect(original).toEqual({ Accept: "*/*" });
  });
});
