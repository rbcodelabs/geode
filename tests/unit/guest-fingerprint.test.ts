import { describe, expect, it } from "vitest";
import {
  addMissingClientHints,
  chromiumMajor,
  classifyHintRequest,
  ClientHintNegotiator,
  clientHintsDisabledByPolicy,
  guestClientHints,
  guestHighEntropyHints,
  normalizeGuestUserAgent,
  parseAcceptCh,
  secChUaArch,
  secChUaBitness,
  secChUaPlatform,
  selectNegotiatedHints,
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

// ---------------------------------------------------------------------------
// Per-origin high-entropy client-hint negotiation (Accept-CH).
//
// Every expectation below is anchored to values MEASURED on this machine, not
// recalled. Two probes produced them:
//
//   1. Real Chrome (Chrome for Testing 149.0.7827.55, macOS 26.4.1) against a
//      loopback origin that sends Accept-CH, to learn the exact wire format.
//   2. This Electron's own guest (Chromium 148.0.7778.254, arm64), reading
//      navigator.userAgentData.getHighEntropyValues(), to learn what values the
//      headers must agree with.
//
// Probe 2's output, verbatim, is the source of the string literals here:
//   architecture "arm", bitness "64", model "", platformVersion "26.4.1",
//   uaFullVersion "148.0.7778.254",
//   fullVersionList [{Not/A)Brand, 99.0.0.0}, {Chromium, 148.0.7778.254}]
// ---------------------------------------------------------------------------

/** The full high-entropy set for this machine, as measured. */
const MEASURED_HIGH_ENTROPY = {
  "Sec-CH-UA-Arch": '"arm"',
  "Sec-CH-UA-Bitness": '"64"',
  "Sec-CH-UA-Full-Version": '"148.0.7778.254"',
  "Sec-CH-UA-Full-Version-List": '"Not/A)Brand";v="99.0.0.0", "Chromium";v="148.0.7778.254"',
  "Sec-CH-UA-Model": '""',
  "Sec-CH-UA-Platform-Version": '"26.4.1"',
  "Sec-CH-UA-WoW64": "?0",
};

const THIS_MACHINE = { chromeVersion: "148.0.7778.254", arch: "arm64", systemVersion: "26.4.1" };

/** united.com's real Accept-CH, copied from the live response. */
const UNITED_ACCEPT_CH =
  "Sec-CH-UA-Arch,Sec-CH-UA-Bitness,Sec-CH-UA-Full-Version,Sec-CH-UA-Full-Version-List," +
  "Sec-CH-UA-Model,Sec-CH-UA-Platform,Sec-CH-UA-Platform-Version,Sec-CH-UA-WoW64";

/** united.com's real Permissions-Policy, abridged to the client-hint features. */
const UNITED_PERMISSIONS_POLICY =
  "geolocation=(self), camera=(), ch-ua-arch=(), ch-ua-bitness=(), " +
  "ch-device-memory=(), ch-dpr=(), ch-viewport-width=()";

describe("secChUaArch / secChUaBitness", () => {
  it("maps the architectures Geode ships on to their UA-CH spec values", () => {
    // Measured: arm64 reports architecture "arm", bitness "64" — NOT "arm64".
    expect(secChUaArch("arm64")).toBe("arm");
    expect(secChUaBitness("arm64")).toBe("64");
    // Chrome reports Intel/AMD 64-bit as "x86" with bitness "64", not "x86_64".
    expect(secChUaArch("x64")).toBe("x86");
    expect(secChUaBitness("x64")).toBe("64");
    expect(secChUaArch("ia32")).toBe("x86");
    expect(secChUaBitness("ia32")).toBe("32");
  });

  it("returns null for an architecture it cannot state truthfully", () => {
    // No invented value: an unknown arch omits the hint entirely.
    expect(secChUaArch("s390x")).toBe(null);
    expect(secChUaBitness("s390x")).toBe(null);
    expect(secChUaArch("")).toBe(null);
  });
});

describe("guestHighEntropyHints", () => {
  it("derives exactly what this machine's Chromium reports, with real Chrome's quoting", () => {
    expect(guestHighEntropyHints(THIS_MACHINE)).toEqual(MEASURED_HIGH_ENTROPY);
  });

  it("quotes strings but not the WoW64 boolean, as real Chrome does", () => {
    const hints = guestHighEntropyHints(THIS_MACHINE);
    // Measured on the wire: every value above is a quoted string...
    expect(hints["Sec-CH-UA-Arch"]).toBe('"arm"');
    expect(hints["Sec-CH-UA-Bitness"]).toBe('"64"');
    // ...including Model, which is a quoted EMPTY string, not an absent header.
    expect(hints["Sec-CH-UA-Model"]).toBe('""');
    // ...except WoW64, a structured-header boolean with no quotes.
    expect(hints["Sec-CH-UA-WoW64"]).toBe("?0");
  });

  it("pads the GREASE brand to four components in the full-version list only", () => {
    // Measured: Sec-CH-UA carries GREASE v="99" while Sec-CH-UA-Full-Version-List
    // carries v="99.0.0.0" for the same brand. The two headers must differ here.
    expect(guestClientHints("148.0.7778.254", "darwin")?.["Sec-CH-UA"]).toContain('"Not/A)Brand";v="99"');
    expect(guestHighEntropyHints(THIS_MACHINE)["Sec-CH-UA-Full-Version-List"])
      .toContain('"Not/A)Brand";v="99.0.0.0"');
  });

  it("keeps the brand order and brand set of Sec-CH-UA, so the two agree", () => {
    // fullVersionList reports GREASE first, then Chromium — same order as brands.
    // A different order or an extra brand would contradict the JS surface.
    const list = guestHighEntropyHints(THIS_MACHINE)["Sec-CH-UA-Full-Version-List"];
    expect(list).toBe('"Not/A)Brand";v="99.0.0.0", "Chromium";v="148.0.7778.254"');
    expect(list).not.toContain("Google Chrome");
    expect(list).not.toMatch(/Electron/i);
  });

  it("tracks the running Chromium and OS instead of hardcoding them", () => {
    const next = guestHighEntropyHints({ chromeVersion: "149.0.1.2", arch: "x64", systemVersion: "15.1" });
    expect(next["Sec-CH-UA-Full-Version"]).toBe('"149.0.1.2"');
    expect(next["Sec-CH-UA-Full-Version-List"]).toBe('"Not/A)Brand";v="99.0.0.0", "Chromium";v="149.0.1.2"');
    expect(next["Sec-CH-UA-Platform-Version"]).toBe('"15.1"');
    expect(next["Sec-CH-UA-Arch"]).toBe('"x86"');
  });

  it("omits the version hints when the Chromium version is unreadable", () => {
    // Consistency beats completeness: no hint is better than a false one.
    const hints = guestHighEntropyHints({ ...THIS_MACHINE, chromeVersion: "" });
    expect(hints["Sec-CH-UA-Full-Version"]).toBeUndefined();
    expect(hints["Sec-CH-UA-Full-Version-List"]).toBeUndefined();
    // The hints that do not depend on it survive.
    expect(hints["Sec-CH-UA-Arch"]).toBe('"arm"');
  });

  it("omits the platform version when the OS version is unreadable", () => {
    const hints = guestHighEntropyHints({ ...THIS_MACHINE, systemVersion: undefined });
    expect(hints["Sec-CH-UA-Platform-Version"]).toBeUndefined();
    expect(hints["Sec-CH-UA-Arch"]).toBe('"arm"');
  });

  it("omits arch, bitness and WoW64 together on an architecture it cannot name", () => {
    const hints = guestHighEntropyHints({ ...THIS_MACHINE, arch: "ppc64" });
    expect(hints["Sec-CH-UA-Arch"]).toBeUndefined();
    expect(hints["Sec-CH-UA-Bitness"]).toBeUndefined();
    // WoW64 is an x86-family concept; claiming ?0 on an arch we cannot name
    // would be asserting something we have not established.
    expect(hints["Sec-CH-UA-WoW64"]).toBeUndefined();
  });

  it("never emits a low-entropy hint, which is sent unconditionally elsewhere", () => {
    const hints = guestHighEntropyHints(THIS_MACHINE);
    expect(hints["Sec-CH-UA"]).toBeUndefined();
    expect(hints["Sec-CH-UA-Mobile"]).toBeUndefined();
    expect(hints["Sec-CH-UA-Platform"]).toBeUndefined();
  });
});

describe("parseAcceptCh", () => {
  it("reads united.com's real Accept-CH into the hints we can supply", () => {
    expect(parseAcceptCh(UNITED_ACCEPT_CH)).toEqual([
      "Sec-CH-UA-Arch",
      "Sec-CH-UA-Bitness",
      "Sec-CH-UA-Full-Version",
      "Sec-CH-UA-Full-Version-List",
      "Sec-CH-UA-Model",
      "Sec-CH-UA-Platform-Version",
      "Sec-CH-UA-WoW64",
    ]);
  });

  it("drops Sec-CH-UA-Platform, which is already sent on every request", () => {
    // It is in united.com's list, but it is low-entropy and unconditional, so
    // tracking it per origin would be dead state.
    expect(parseAcceptCh("Sec-CH-UA-Platform")).toEqual([]);
    expect(parseAcceptCh(UNITED_ACCEPT_CH)).not.toContain("Sec-CH-UA-Platform");
  });

  it("tolerates the whitespace and casing real servers send", () => {
    expect(parseAcceptCh("  sec-ch-ua-arch ,\tSEC-CH-UA-BITNESS,\n Sec-CH-UA-Model ")).toEqual([
      "Sec-CH-UA-Arch",
      "Sec-CH-UA-Bitness",
      "Sec-CH-UA-Model",
    ]);
  });

  it("canonicalizes casing so the emitted header name is real Chrome's", () => {
    // WoW64's internal capitals are not reproducible by simple title-casing.
    expect(parseAcceptCh("sec-ch-ua-wow64")).toEqual(["Sec-CH-UA-WoW64"]);
  });

  it("joins a repeated Accept-CH header, as Electron reports it as an array", () => {
    expect(parseAcceptCh(["Sec-CH-UA-Arch", "Sec-CH-UA-Bitness,Sec-CH-UA-Model"])).toEqual([
      "Sec-CH-UA-Arch",
      "Sec-CH-UA-Bitness",
      "Sec-CH-UA-Model",
    ]);
  });

  it("ignores hints it cannot derive rather than sending an empty or invented one", () => {
    // DPR, Width and Device-Memory are real hints Geode does not derive.
    expect(parseAcceptCh("DPR,Width,Sec-CH-Device-Memory,Downlink,Sec-CH-UA-Arch")).toEqual(["Sec-CH-UA-Arch"]);
  });

  it("de-duplicates a hint an origin lists twice", () => {
    expect(parseAcceptCh("Sec-CH-UA-Arch,Sec-CH-UA-Arch")).toEqual(["Sec-CH-UA-Arch"]);
  });

  it("returns nothing for an absent, empty or junk header", () => {
    expect(parseAcceptCh(undefined)).toEqual([]);
    expect(parseAcceptCh("")).toEqual([]);
    expect(parseAcceptCh("   ")).toEqual([]);
    expect(parseAcceptCh(",,,")).toEqual([]);
    expect(parseAcceptCh([])).toEqual([]);
  });
});

describe("clientHintsDisabledByPolicy", () => {
  it("reads united.com's real Permissions-Policy as disabling arch and bitness", () => {
    // This is the case the whole intersection exists for: united.com asks for
    // Sec-CH-UA-Arch in Accept-CH and disables ch-ua-arch in the same response.
    expect(clientHintsDisabledByPolicy(UNITED_PERMISSIONS_POLICY)).toEqual([
      "Sec-CH-UA-Arch",
      "Sec-CH-UA-Bitness",
    ]);
  });

  it("treats only an EMPTY allowlist as disabled", () => {
    // `()` disables for everyone. Anything naming an origin still allows self.
    expect(clientHintsDisabledByPolicy("ch-ua-arch=()")).toEqual(["Sec-CH-UA-Arch"]);
    expect(clientHintsDisabledByPolicy("ch-ua-arch=(self)")).toEqual([]);
    expect(clientHintsDisabledByPolicy("ch-ua-arch=self")).toEqual([]);
    expect(clientHintsDisabledByPolicy("ch-ua-arch=*")).toEqual([]);
    expect(clientHintsDisabledByPolicy('ch-ua-arch=(self "https://a.example")')).toEqual([]);
  });

  it("does not mistake a quoted origin's comma for a feature separator", () => {
    // Splitting naively on "," would read `"https://b.example")` as a feature.
    const policy = 'ch-ua-model=(self "https://a.example" "https://b.example"), ch-ua-bitness=()';
    expect(clientHintsDisabledByPolicy(policy)).toEqual(["Sec-CH-UA-Bitness"]);
  });

  it("ignores whitespace inside an otherwise empty allowlist", () => {
    expect(clientHintsDisabledByPolicy("ch-ua-arch=(  )")).toEqual(["Sec-CH-UA-Arch"]);
  });

  it("maps every client-hint policy feature to its header name", () => {
    const policy = [
      "ch-ua-arch=()", "ch-ua-bitness=()", "ch-ua-full-version=()",
      "ch-ua-full-version-list=()", "ch-ua-model=()", "ch-ua-platform-version=()",
      "ch-ua-wow64=()",
    ].join(", ");
    expect(clientHintsDisabledByPolicy(policy)).toEqual([
      "Sec-CH-UA-Arch",
      "Sec-CH-UA-Bitness",
      "Sec-CH-UA-Full-Version",
      "Sec-CH-UA-Full-Version-List",
      "Sec-CH-UA-Model",
      "Sec-CH-UA-Platform-Version",
      "Sec-CH-UA-WoW64",
    ]);
  });

  it("ignores non-client-hint features and unknown ch features", () => {
    expect(clientHintsDisabledByPolicy("geolocation=(), camera=(), ch-nonsense=()")).toEqual([]);
  });

  it("never reports a low-entropy hint as disabled", () => {
    // Those three are sent unconditionally by design (see attachGuestClientHints),
    // so surfacing them here could only mislead a future caller into stripping
    // the headers PR #248 exists to add.
    expect(clientHintsDisabledByPolicy("ch-ua=(), ch-ua-mobile=(), ch-ua-platform=()")).toEqual([]);
  });

  it("joins a repeated Permissions-Policy header", () => {
    expect(clientHintsDisabledByPolicy(["ch-ua-arch=()", "ch-ua-model=()"])).toEqual([
      "Sec-CH-UA-Arch",
      "Sec-CH-UA-Model",
    ]);
  });

  it("returns nothing for an absent or junk header", () => {
    expect(clientHintsDisabledByPolicy(undefined)).toEqual([]);
    expect(clientHintsDisabledByPolicy("")).toEqual([]);
    expect(clientHintsDisabledByPolicy("garbage without equals")).toEqual([]);
  });
});

describe("classifyHintRequest", () => {
  it("calls a document load a navigation, whatever the initiator", () => {
    // Measured: on a top-level navigation real Chrome sends the hints even when
    // the previous document disabled them, so the initiator is irrelevant here.
    expect(classifyHintRequest("mainFrame", "https://a.example/p", null)).toBe("navigation");
    expect(classifyHintRequest("subFrame", "https://a.example/p", "https://b.example/")).toBe("navigation");
  });

  it("separates same-origin from cross-origin subresources", () => {
    expect(classifyHintRequest("xhr", "https://a.example/api", "https://a.example/page"))
      .toBe("sameOriginSubresource");
    expect(classifyHintRequest("xhr", "https://b.example/api", "https://a.example/page"))
      .toBe("crossOriginSubresource");
    // Port and scheme are part of the origin.
    expect(classifyHintRequest("image", "https://a.example:8443/i", "https://a.example/page"))
      .toBe("crossOriginSubresource");
    expect(classifyHintRequest("image", "http://a.example/i", "https://a.example/page"))
      .toBe("crossOriginSubresource");
  });

  it("treats an unknown initiator as cross-origin, which withholds hints", () => {
    // Withholding is the status quo and leaks nothing; guessing "same origin"
    // would send high-entropy hints on a request we cannot attribute.
    expect(classifyHintRequest("xhr", "https://a.example/api", null)).toBe("crossOriginSubresource");
    expect(classifyHintRequest("xhr", "https://a.example/api", "")).toBe("crossOriginSubresource");
    expect(classifyHintRequest("xhr", "https://a.example/api", "about:blank")).toBe("crossOriginSubresource");
  });

  it("treats an unparseable request url as cross-origin", () => {
    expect(classifyHintRequest("xhr", "not a url", "https://a.example/p")).toBe("crossOriginSubresource");
  });
});

describe("selectNegotiatedHints", () => {
  const available = guestHighEntropyHints(THIS_MACHINE);
  const policy = {
    accepted: parseAcceptCh(UNITED_ACCEPT_CH),
    disabled: clientHintsDisabledByPolicy(UNITED_PERMISSIONS_POLICY),
  };

  it("sends nothing to an origin that never asked", () => {
    // Requirement: never broadcast high-entropy hints. This is the privacy case.
    expect(selectNegotiatedHints(null, available, "navigation")).toEqual({});
    expect(selectNegotiatedHints(null, available, "sameOriginSubresource")).toEqual({});
  });

  it("sends the full accepted set on a navigation, policy notwithstanding", () => {
    expect(selectNegotiatedHints(policy, available, "navigation")).toEqual({
      "Sec-CH-UA-Arch": '"arm"',
      "Sec-CH-UA-Bitness": '"64"',
      "Sec-CH-UA-Full-Version": '"148.0.7778.254"',
      "Sec-CH-UA-Full-Version-List": '"Not/A)Brand";v="99.0.0.0", "Chromium";v="148.0.7778.254"',
      "Sec-CH-UA-Model": '""',
      "Sec-CH-UA-Platform-Version": '"26.4.1"',
      "Sec-CH-UA-WoW64": "?0",
    });
  });

  it("withholds the policy-disabled hints on a same-origin subresource", () => {
    // THE case from the brief: united.com asks for Sec-CH-UA-Arch and
    // Sec-CH-UA-Bitness, and disables both. An XHR must carry neither.
    const sent = selectNegotiatedHints(policy, available, "sameOriginSubresource");
    expect(sent["Sec-CH-UA-Arch"]).toBeUndefined();
    expect(sent["Sec-CH-UA-Bitness"]).toBeUndefined();
    // Everything else it asked for still goes.
    expect(sent).toEqual({
      "Sec-CH-UA-Full-Version": '"148.0.7778.254"',
      "Sec-CH-UA-Full-Version-List": '"Not/A)Brand";v="99.0.0.0", "Chromium";v="148.0.7778.254"',
      "Sec-CH-UA-Model": '""',
      "Sec-CH-UA-Platform-Version": '"26.4.1"',
      "Sec-CH-UA-WoW64": "?0",
    });
  });

  it("sends nothing on a cross-origin subresource", () => {
    // Measured: real Chrome delegates no high-entropy hint to a third party
    // unless the embedding document's Permissions-Policy allows it.
    expect(selectNegotiatedHints(policy, available, "crossOriginSubresource")).toEqual({});
  });

  it("sends only hints it can actually derive", () => {
    // An origin asking for a hint we omitted for consistency must not get an
    // empty or invented value.
    const partial = guestHighEntropyHints({ ...THIS_MACHINE, systemVersion: undefined });
    const sent = selectNegotiatedHints(policy, partial, "navigation");
    expect(sent["Sec-CH-UA-Platform-Version"]).toBeUndefined();
    expect(sent["Sec-CH-UA-Arch"]).toBe('"arm"');
  });

  it("sends only what the origin asked for, not the whole set", () => {
    const narrow = { accepted: ["Sec-CH-UA-Arch"], disabled: [] };
    expect(selectNegotiatedHints(narrow, available, "navigation")).toEqual({ "Sec-CH-UA-Arch": '"arm"' });
  });
});

describe("ClientHintNegotiator", () => {
  const available = guestHighEntropyHints(THIS_MACHINE);
  const documentResponse = (acceptCh: string, permissionsPolicy?: string) => ({
    "Content-Type": ["text/html"],
    "Accept-CH": [acceptCh],
    ...(permissionsPolicy ? { "Permissions-Policy": [permissionsPolicy] } : {}),
  });

  it("sends nothing before an origin has asked", () => {
    const negotiator = new ClientHintNegotiator(available);
    expect(negotiator.hintsForRequest("https://a.example/p", "mainFrame", null)).toEqual({});
  });

  it("sends an origin's hints once it has asked, and only to that origin", () => {
    const negotiator = new ClientHintNegotiator(available);
    negotiator.learnFromResponse("https://a.example/p", "mainFrame", documentResponse("Sec-CH-UA-Arch"));

    expect(negotiator.hintsForRequest("https://a.example/other", "mainFrame", null))
      .toEqual({ "Sec-CH-UA-Arch": '"arm"' });
    // A different origin is untouched — this is the per-origin requirement.
    expect(negotiator.hintsForRequest("https://b.example/p", "mainFrame", null)).toEqual({});
    // ...and so is a different port on the same host.
    expect(negotiator.hintsForRequest("https://a.example:8443/p", "mainFrame", null)).toEqual({});
  });

  it("intersects Accept-CH with Permissions-Policy for subresources", () => {
    const negotiator = new ClientHintNegotiator(available);
    negotiator.learnFromResponse(
      "https://united.example/home",
      "mainFrame",
      documentResponse(UNITED_ACCEPT_CH, UNITED_PERMISSIONS_POLICY),
    );

    const xhr = negotiator.hintsForRequest(
      "https://united.example/xapi/auth/signin",
      "xhr",
      "https://united.example/home",
    );
    expect(xhr["Sec-CH-UA-Arch"]).toBeUndefined();
    expect(xhr["Sec-CH-UA-Bitness"]).toBeUndefined();
    expect(xhr["Sec-CH-UA-Full-Version"]).toBe('"148.0.7778.254"');

    // The navigation to the same origin still carries them, as measured.
    const nav = negotiator.hintsForRequest("https://united.example/home", "mainFrame", null);
    expect(nav["Sec-CH-UA-Arch"]).toBe('"arm"');
  });

  it("learns only from document responses, as Accept-CH is navigation-scoped", () => {
    const negotiator = new ClientHintNegotiator(available);
    negotiator.learnFromResponse("https://a.example/data.json", "xhr", documentResponse("Sec-CH-UA-Arch"));
    expect(negotiator.trackedOrigins).toBe(0);
    expect(negotiator.hintsForRequest("https://a.example/p", "mainFrame", null)).toEqual({});
  });

  it("does not track an origin whose Accept-CH asks for nothing we supply", () => {
    // Keeps the bounded map free of dead entries.
    const negotiator = new ClientHintNegotiator(available);
    negotiator.learnFromResponse("https://a.example/p", "mainFrame", documentResponse("DPR,Width"));
    expect(negotiator.trackedOrigins).toBe(0);
  });

  it("replaces an origin's entry when it sends a new Accept-CH", () => {
    const negotiator = new ClientHintNegotiator(available);
    negotiator.learnFromResponse("https://a.example/p", "mainFrame", documentResponse(UNITED_ACCEPT_CH));
    negotiator.learnFromResponse("https://a.example/p", "mainFrame", documentResponse("Sec-CH-UA-Model"));
    expect(negotiator.trackedOrigins).toBe(1);
    expect(negotiator.hintsForRequest("https://a.example/p", "mainFrame", null))
      .toEqual({ "Sec-CH-UA-Model": '""' });
  });

  it("reads response header names case-insensitively", () => {
    const negotiator = new ClientHintNegotiator(available);
    negotiator.learnFromResponse("https://a.example/p", "mainFrame", {
      "accept-ch": ["Sec-CH-UA-Arch"],
      "PERMISSIONS-POLICY": ["ch-ua-arch=()"],
    });
    expect(negotiator.hintsForRequest("https://a.example/p", "mainFrame", null))
      .toEqual({ "Sec-CH-UA-Arch": '"arm"' });
    expect(negotiator.hintsForRequest("https://a.example/api", "xhr", "https://a.example/p")).toEqual({});
  });

  it("ignores a response with no headers at all", () => {
    const negotiator = new ClientHintNegotiator(available);
    negotiator.learnFromResponse("https://a.example/p", "mainFrame", undefined);
    expect(negotiator.trackedOrigins).toBe(0);
  });

  it("ignores a non-http origin", () => {
    const negotiator = new ClientHintNegotiator(available);
    negotiator.learnFromResponse("file:///tmp/x.html", "mainFrame", documentResponse("Sec-CH-UA-Arch"));
    negotiator.learnFromResponse("not a url", "mainFrame", documentResponse("Sec-CH-UA-Arch"));
    expect(negotiator.trackedOrigins).toBe(0);
  });

  it("bounds the per-origin map so a long session cannot grow it without limit", () => {
    const negotiator = new ClientHintNegotiator(available, 3);
    for (let i = 0; i < 50; i += 1) {
      negotiator.learnFromResponse(`https://o${i}.example/p`, "mainFrame", documentResponse("Sec-CH-UA-Arch"));
    }
    expect(negotiator.trackedOrigins).toBe(3);
    // The oldest are gone...
    expect(negotiator.hintsForRequest("https://o0.example/p", "mainFrame", null)).toEqual({});
    // ...and the newest survive.
    expect(negotiator.hintsForRequest("https://o49.example/p", "mainFrame", null))
      .toEqual({ "Sec-CH-UA-Arch": '"arm"' });
  });

  it("evicts least-RECENTLY-USED, so an origin still in use is not dropped", () => {
    const negotiator = new ClientHintNegotiator(available, 2);
    negotiator.learnFromResponse("https://keep.example/p", "mainFrame", documentResponse("Sec-CH-UA-Arch"));
    negotiator.learnFromResponse("https://other.example/p", "mainFrame", documentResponse("Sec-CH-UA-Arch"));
    // Touch `keep` so it becomes the most recently used.
    expect(negotiator.hintsForRequest("https://keep.example/p", "mainFrame", null)).not.toEqual({});
    // A third origin evicts `other`, not `keep`.
    negotiator.learnFromResponse("https://third.example/p", "mainFrame", documentResponse("Sec-CH-UA-Arch"));
    expect(negotiator.trackedOrigins).toBe(2);
    expect(negotiator.hintsForRequest("https://keep.example/p", "mainFrame", null)).not.toEqual({});
    expect(negotiator.hintsForRequest("https://other.example/p", "mainFrame", null)).toEqual({});
  });

  it("does nothing at all when no high-entropy hint could be derived", () => {
    const negotiator = new ClientHintNegotiator({});
    negotiator.learnFromResponse("https://a.example/p", "mainFrame", documentResponse(UNITED_ACCEPT_CH));
    expect(negotiator.hintsForRequest("https://a.example/p", "mainFrame", null)).toEqual({});
  });
});
