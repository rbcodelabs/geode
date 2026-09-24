/**
 * Browser-fingerprint normalization for Geode's webview guests.
 *
 * ## Why
 *
 * Geode's embedded browser guests were being rejected by bot-detection
 * systems. united.com killed the connection outright with
 * ERR_HTTP2_PROTOCOL_ERROR — not a challenge page, not a 403, a refusal at the
 * protocol level. A/B on the live site against the same build isolated the
 * cause to a single token: with `Electron/42.4.0` in the UA the connection
 * died; with it stripped the page loaded normally.
 *
 * Four surfaces share that defect, because all four are `<webview>` guests
 * inside this Electron process:
 *
 *   - the Agent Browser guest (`persist:agent-browser`, created by the
 *     obsidian-claude-threads plugin — it runs inside Geode's process, so a
 *     host-side fix covers it without touching that repo);
 *   - the Web Viewer tab (`persist:webviewer`, src/renderer/views/web-view.ts);
 *   - the artifact view (`geode-artifact-*`, src/renderer/views/artifact-view.ts);
 *   - the canvas link preview (`persist:canvas-preview`, src/renderer/views/canvas-view.ts).
 *
 * ## What it presents as
 *
 * "Authentic stock Chromium." The guest genuinely *is* current Chromium, and
 * stock Chromium legitimately sends a `Chrome/<version>` UA token while
 * legitimately reporting its brands as Chromium with no "Google Chrome" entry.
 * So removing the embedder tokens yields an identity that is both truthful and
 * self-consistent — we are not forging a browser we aren't.
 *
 * ## The governing rule: internal consistency beats cosmetic improvement
 *
 * A contradictory fingerprint scores *worse* with detectors than an
 * unusual-but-coherent one. `navigator.userAgentData.brands` cannot be
 * overridden from the host by any lever (verified: overriding the UA by any
 * method leaves `brands` untouched), so the `Sec-CH-UA` header built here is
 * derived to match what Chromium already reports in JS, exactly. Forging a
 * "Google Chrome" brand in the header would look better in isolation and
 * *worse* in practice, because the header would then contradict the JS
 * surface. Anywhere a value cannot be made consistent across both the header
 * and the JS surface, it is left alone — see the Accept-Language note in
 * src/main/main.ts.
 *
 * Everything is derived at runtime from `process.versions.chrome` and
 * `process.platform`. Nothing is hardcoded, so it cannot go stale as Electron
 * upgrades.
 *
 * ## Two layers
 *
 * 1. The UA strip and the three LOW-entropy hints Electron omits, sent on every
 *    request. That is the original PR #248 scope, above.
 * 2. Per-origin negotiation of the HIGH-entropy hints, which Electron does not
 *    implement at all: an origin that sends `Accept-CH` gets what it asked for
 *    on subsequent requests, and no origin that did not ask gets anything. See
 *    the section beginning "Per-origin high-entropy client-hint negotiation"
 *    lower down for the measured Chrome behavior it reproduces and the
 *    deliberate limits.
 */

/**
 * Tokens that name the embedder rather than the engine. Chromium's own tokens
 * (`Chrome/`, `AppleWebKit/`, `Safari/`) are deliberately left in place: they
 * are true, and stock Chromium sends them.
 *
 * Electron's default UA carries *two* embedder tokens, not one. Measured on
 * this build:
 *
 *   ...(KHTML, like Gecko) geode/0.22.2 Chrome/148.0.7778.254 Electron/42.4.0 Safari/537.36
 *                          ^^^^^^^^^^^^                       ^^^^^^^^^^^^^^^
 *
 * The first is `app.getName()/app.getVersion()`, injected by Electron ahead of
 * the Chrome token and lowercase in development (package.json `name`) but
 * capitalized in a packaged build (electron-builder `productName`). Matching is
 * therefore case-insensitive, and the product token is passed in rather than
 * hardcoded so a rename cannot silently reintroduce this bug. `Geode` is also
 * listed literally as a fallback for callers that do not supply a name.
 */
const EMBEDDER_TOKENS = /\s+(?:Electron|Geode)\/[\d.]+/gi;

/** Escape a product name for literal use inside a RegExp. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The GREASE brand Chromium pads its brand list with. Hardcoded because it is
 * not derivable from `process.versions` — but it is *pinned* by
 * tests/e2e/webview-fingerprint.spec.ts, which asserts the header this builds
 * matches the guest's real `navigator.userAgentData.brands` character for
 * character. If a future Chromium changes the GREASE brand, that test fails
 * loudly rather than letting us ship a header that contradicts the JS surface.
 */
const GREASE_BRAND = "Not/A)Brand";
const GREASE_VERSION = "99";

/** UA-CH platform names, per the User-Agent Client Hints spec. */
const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/**
 * A set of client hints keyed by header name. Used both for the three
 * low-entropy hints sent on every request and for the negotiated high-entropy
 * hints sent only to origins that asked (see `ClientHintNegotiator`).
 */
export type GuestClientHints = Readonly<Record<string, string>>;

/**
 * Strip embedder tokens from a user-agent string, leaving a stock Chromium UA.
 *
 * `productName` should be `app.getName()`, whose `<name>/<version>` token
 * Electron injects ahead of the Chrome token.
 *
 * Idempotent, so it is safe to apply to a UA that has already been normalized
 * (e.g. if `app.userAgentFallback` is read back after being set).
 */
export function normalizeGuestUserAgent(userAgent: string, productName?: string): string {
  const product = productName?.trim();
  const withoutProduct = product
    ? userAgent.replace(new RegExp(`\\s+${escapeForRegExp(product)}\\/[\\d.]+`, "gi"), "")
    : userAgent;
  return withoutProduct.replace(EMBEDDER_TOKENS, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * The major version of a Chromium version string, or `null` if it cannot be
 * read. `null` is propagated rather than defaulted: a wrong brand version is a
 * contradiction, and no hint at all is better than a false one.
 */
export function chromiumMajor(chromeVersion: string | undefined): string | null {
  const major = /^(\d+)\./.exec(chromeVersion ?? "")?.[1];
  return major ?? null;
}

/**
 * The UA-CH platform name for a Node platform id. Unrecognized platforms get
 * the spec's own `"Unknown"` rather than an invented name.
 */
export function secChUaPlatform(platform: NodeJS.Platform): string {
  return PLATFORM_NAMES[platform] ?? "Unknown";
}

/**
 * Build the client-hint header set for the running Chromium, or `null` when
 * the Chromium version is unreadable (in which case no hints are sent at all —
 * the status quo — rather than a partial or invented set).
 */
export function guestClientHints(
  chromeVersion: string | undefined,
  platform: NodeJS.Platform,
): GuestClientHints | null {
  const major = chromiumMajor(chromeVersion);
  if (!major) return null;
  return {
    // Must match navigator.userAgentData.brands exactly. See GREASE_BRAND.
    "Sec-CH-UA": `"${GREASE_BRAND}";v="${GREASE_VERSION}", "Chromium";v="${major}"`,
    // Structured-header boolean: ?0 is false. Every guest is a desktop webview.
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": `"${secChUaPlatform(platform)}"`,
  };
}

/**
 * Add only the client hints a request is missing, and return the new header
 * set — or `null` when every hint is already present, so the caller can leave
 * the request completely untouched.
 *
 * Never overwrites an existing hint. If a later Electron starts sending these
 * natively, ours yields instead of duplicating or fighting it. Header names are
 * compared case-insensitively because HTTP header names are.
 */
export function addMissingClientHints(
  requestHeaders: Record<string, string>,
  hints: GuestClientHints,
): Record<string, string> | null {
  const present = new Set(Object.keys(requestHeaders).map((name) => name.toLowerCase()));
  const missing = Object.entries(hints).filter(([name]) => !present.has(name.toLowerCase()));
  if (missing.length === 0) return null;
  return { ...requestHeaders, ...Object.fromEntries(missing) };
}

// ===========================================================================
// Per-origin high-entropy client-hint negotiation (Accept-CH)
//
// Electron implements no client-hint negotiation at all. Real Chrome, on
// receiving an `Accept-CH` response header from an origin, remembers what that
// origin asked for and sends those HIGH-entropy hints on subsequent requests to
// it. Geode sent none of them, which is a plain behavioral gap versus the
// Chromium it claims to be in its UA.
//
// ## What real Chrome actually does — measured, not assumed
//
// Two probes established the behavior this code reproduces. The first drove real
// Chrome (Chrome for Testing 149.0.7827.55, macOS 26.4.1) against loopback
// origins that send `Accept-CH` with and without a restrictive
// `Permissions-Policy`. The second read this Electron guest's own
// `navigator.userAgentData.getHighEntropyValues()` so the header values could be
// derived to agree with it exactly.
//
// The first probe overturned the assumption this work started from. It is NOT
// true that `Permissions-Policy: ch-ua-arch=()` simply suppresses
// `Sec-CH-UA-Arch` for an origin. What was measured, per request kind, with an
// origin whose response carried both `Accept-CH: Sec-CH-UA-Arch,...` and
// `Permissions-Policy: ch-ua-arch=(), ch-ua-bitness=()`:
//
//   | request kind                        | Sec-CH-UA-Arch sent? |
//   |-------------------------------------|----------------------|
//   | top-level navigation to the origin  | YES                  |
//   | same-origin subresource (xhr, img)  | NO                   |
//   | cross-origin subresource            | NO — and no other    |
//   |                                     | high-entropy hint    |
//
// So the permissions policy governs DELEGATION to subresources, not the
// document request. A blanket intersection would have withheld arch and bitness
// from the navigation, which real Chrome sends — itself a fingerprint anomaly.
// The cross-origin row is the other half: a third-party origin gets no
// high-entropy hint even when it asked via `Accept-CH`, unless the embedding
// document delegates it. Sending them there would be a privacy leak.
//
// ## Deliberate limits (see PR discussion for the full list)
//
//   - The three LOW-entropy hints stay unconditional, exactly as PR #248 shipped
//     them. Real Chrome was measured to drop even those on a subresource under
//     `ch-ua=(), ch-ua-mobile=(), ch-ua-platform=()`, so this is a known
//     divergence. It is left in place on purpose: the trigger is vanishingly
//     rare (an origin disabling `ch-ua` breaks its own UA detection), and a
//     false positive in policy parsing would silently undo the fix #248 exists
//     to deliver. `clientHintsDisabledByPolicy` therefore refuses to report a
//     low-entropy hint as disabled at all, so no future caller can strip them by
//     accident.
//   - `Critical-CH` is not honored. Real Chrome retries the request immediately
//     when an origin marks a hint critical; this fills hints in on SUBSEQUENT
//     requests only, so the very first request to an origin carries none.
//   - `Accept-CH` is read from navigation responses only, which is what the
//     spec scopes it to and what keeps the per-origin map small.
// ===========================================================================

/**
 * The high-entropy hints Geode can derive truthfully, in the canonical casing
 * real Chrome puts on the wire. `Sec-CH-UA-WoW64`'s internal capitals are why
 * incoming `Accept-CH` tokens are mapped through this list rather than
 * title-cased.
 *
 * `Sec-CH-UA`, `-Mobile` and `-Platform` are absent by design: they are
 * low-entropy, sent on every request by `attachGuestClientHints`, and must not
 * be made conditional on negotiation.
 */
const HIGH_ENTROPY_HEADERS = [
  "Sec-CH-UA-Arch",
  "Sec-CH-UA-Bitness",
  "Sec-CH-UA-Full-Version",
  "Sec-CH-UA-Full-Version-List",
  "Sec-CH-UA-Model",
  "Sec-CH-UA-Platform-Version",
  "Sec-CH-UA-WoW64",
] as const;

const CANONICAL_HINT_BY_LOWERCASE = new Map(
  HIGH_ENTROPY_HEADERS.map((name) => [name.toLowerCase(), name as string]),
);

/**
 * Permissions-Policy feature names to the hint header each one gates.
 *
 * `ch-ua`, `ch-ua-mobile` and `ch-ua-platform` are deliberately absent — see
 * the low-entropy note above. Omitting them here is what makes it impossible
 * for policy parsing to withhold the hints PR #248 adds.
 */
const POLICY_FEATURE_HEADERS: Readonly<Record<string, string>> = {
  "ch-ua-arch": "Sec-CH-UA-Arch",
  "ch-ua-bitness": "Sec-CH-UA-Bitness",
  "ch-ua-full-version": "Sec-CH-UA-Full-Version",
  "ch-ua-full-version-list": "Sec-CH-UA-Full-Version-List",
  "ch-ua-model": "Sec-CH-UA-Model",
  "ch-ua-platform-version": "Sec-CH-UA-Platform-Version",
  "ch-ua-wow64": "Sec-CH-UA-WoW64",
};

/**
 * UA-CH architecture names per `process.arch`. Measured: an arm64 Mac reports
 * architecture `"arm"` and bitness `"64"` — the arch name carries no width, the
 * bitness hint does. Intel/AMD 64-bit is `"x86"` with bitness `"64"`, not
 * `"x86_64"`.
 */
const ARCH_NAMES: Readonly<Record<string, string>> = {
  arm64: "arm",
  arm: "arm",
  x64: "x86",
  ia32: "x86",
};

const ARCH_BITNESS: Readonly<Record<string, string>> = {
  arm64: "64",
  x64: "64",
  arm: "32",
  ia32: "32",
};

/** Resource types that are a document load rather than a subresource fetch. */
const NAVIGATION_RESOURCE_TYPES: ReadonlySet<string> = new Set(["mainFrame", "subFrame"]);

/** How many origins' negotiated hints to remember. Bounds a long session. */
const DEFAULT_TRACKED_ORIGIN_LIMIT = 128;

/** The UA-CH architecture name for a `process.arch`, or `null` if unmappable. */
export function secChUaArch(arch: string): string | null {
  return ARCH_NAMES[arch] ?? null;
}

/** The UA-CH bitness for a `process.arch`, or `null` if unmappable. */
export function secChUaBitness(arch: string): string | null {
  return ARCH_BITNESS[arch] ?? null;
}

/** Everything the high-entropy hints are derived from. Nothing is hardcoded. */
export type GuestPlatformFacts = {
  /** `process.versions.chrome`, e.g. "148.0.7778.254". */
  readonly chromeVersion: string | undefined;
  /** `process.arch`, e.g. "arm64". */
  readonly arch: string;
  /**
   * The OS product version. `process.getSystemVersion()` is the lever, NOT
   * `os.release()`: on macOS 26.4.1 the former returns "26.4.1" (what Chromium
   * reports as `platformVersion`) while the latter returns the Darwin kernel
   * version "25.4.0", which would contradict the JS surface.
   */
  readonly systemVersion: string | undefined;
};

/** A dotted numeric Chromium version, or `null` if it cannot be trusted. */
function fullChromiumVersion(version: string | undefined): string | null {
  const trimmed = version?.trim() ?? "";
  return /^\d+(?:\.\d+)+$/.test(trimmed) ? trimmed : null;
}

/**
 * Build every high-entropy hint that can be stated truthfully for the running
 * guest. Hints whose inputs are unreadable are OMITTED rather than guessed —
 * the same rule the low-entropy set follows, because a contradictory value
 * scores worse with detectors than an absent one.
 *
 * Verified against this Electron guest's own
 * `navigator.userAgentData.getHighEntropyValues()`; tests/e2e/webview-client-hints
 * .spec.ts re-asserts that agreement against the live guest so a future
 * Chromium cannot drift away from it silently.
 */
export function guestHighEntropyHints(facts: GuestPlatformFacts): GuestClientHints {
  const hints: Record<string, string> = {};

  const arch = secChUaArch(facts.arch);
  const bitness = secChUaBitness(facts.arch);
  if (arch) hints["Sec-CH-UA-Arch"] = `"${arch}"`;
  if (bitness) hints["Sec-CH-UA-Bitness"] = `"${bitness}"`;

  const full = fullChromiumVersion(facts.chromeVersion);
  if (full) {
    hints["Sec-CH-UA-Full-Version"] = `"${full}"`;
    // Measured: the same GREASE brand appears as v="99" in Sec-CH-UA but padded
    // to v="99.0.0.0" here, and GREASE comes FIRST, matching the order of both
    // navigator.userAgentData.brands and fullVersionList.
    hints["Sec-CH-UA-Full-Version-List"] =
      `"${GREASE_BRAND}";v="${GREASE_VERSION}.0.0.0", "Chromium";v="${full}"`;
  }

  // Measured as a quoted EMPTY string on desktop, not an omitted header.
  hints["Sec-CH-UA-Model"] = '""';

  const systemVersion = facts.systemVersion?.trim();
  if (systemVersion) hints["Sec-CH-UA-Platform-Version"] = `"${systemVersion}"`;

  // Structured-header boolean, unquoted. Gated on a known architecture: WoW64 is
  // an x86-family concept, so on an arch we cannot even name, asserting ?0 would
  // be claiming something unestablished.
  if (arch) hints["Sec-CH-UA-WoW64"] = "?0";

  return hints;
}

/** Collapse a possibly-repeated header into one comma-joined string. */
function joinHeaderValues(value: string | readonly string[] | undefined): string {
  return Array.isArray(value) ? value.join(",") : (value as string | undefined) ?? "";
}

/**
 * Read an `Accept-CH` header into the canonical names of the hints Geode can
 * actually supply. Unknown or underivable tokens (`DPR`, `Width`,
 * `Sec-CH-Device-Memory`) are dropped rather than answered with an empty value,
 * and `Sec-CH-UA-Platform` is dropped because it is already sent on every
 * request — tracking it per origin would be dead state.
 *
 * Header order is preserved and duplicates collapse.
 */
export function parseAcceptCh(value: string | readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const accepted: string[] = [];
  for (const token of joinHeaderValues(value).split(",")) {
    const canonical = CANONICAL_HINT_BY_LOWERCASE.get(token.trim().toLowerCase());
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    accepted.push(canonical);
  }
  return accepted;
}

/**
 * Split a Permissions-Policy header on its top-level commas, ignoring commas
 * inside an allowlist's parentheses or inside a quoted origin. Splitting
 * naively would read `"https://b.example")` as a feature name.
 */
function splitPolicyDirectives(header: string): string[] {
  const directives: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (const char of header) {
    if (quoted) {
      current += char;
      if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      directives.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  directives.push(current);
  return directives;
}

/**
 * An allowlist of `()` disables the feature for every origin, including self.
 * Anything that names an origin — `*`, `self`, `(self)`, `(self "https://x")` —
 * still permits it for at least the document itself, so it is not a disable.
 */
function isEmptyAllowlist(allowlist: string): boolean {
  if (!allowlist.startsWith("(") || !allowlist.endsWith(")")) return false;
  return allowlist.slice(1, -1).trim() === "";
}

/**
 * The hint headers a `Permissions-Policy` disables outright.
 *
 * Only an empty allowlist counts, and only the high-entropy features are
 * considered — a low-entropy hint can never be reported here. See the
 * low-entropy note above for why that restriction is load-bearing.
 */
export function clientHintsDisabledByPolicy(value: string | readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const disabled: string[] = [];
  for (const directive of splitPolicyDirectives(joinHeaderValues(value))) {
    const separator = directive.indexOf("=");
    if (separator < 0) continue;
    const feature = directive.slice(0, separator).trim().toLowerCase();
    if (!isEmptyAllowlist(directive.slice(separator + 1).trim())) continue;
    const header = POLICY_FEATURE_HEADERS[feature];
    if (!header || seen.has(header)) continue;
    seen.add(header);
    disabled.push(header);
  }
  return disabled;
}

/**
 * The origin of an http(s) URL, or `null` for anything else — a non-web scheme,
 * `about:blank`, or an unparseable string. Scheme, host and port all
 * participate, so `https://a.example` and `https://a.example:8443` are distinct.
 */
export function httpOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Which of real Chrome's three measured behaviors applies to a request. */
export type HintRequestKind = "navigation" | "sameOriginSubresource" | "crossOriginSubresource";

/**
 * Classify a request against the table measured at the top of this section.
 *
 * A document load is a navigation regardless of who initiated it, because the
 * previous document's permissions policy was measured NOT to suppress hints on
 * it. An unattributable subresource is treated as cross-origin, which withholds
 * every high-entropy hint: that is the status quo and leaks nothing, whereas
 * assuming same-origin would send them on a request we cannot account for.
 */
export function classifyHintRequest(
  resourceType: string,
  requestUrl: string,
  initiatorUrl: string | null | undefined,
): HintRequestKind {
  if (NAVIGATION_RESOURCE_TYPES.has(resourceType)) return "navigation";
  const target = httpOrigin(requestUrl);
  const initiator = httpOrigin(initiatorUrl);
  return target && initiator && target === initiator ? "sameOriginSubresource" : "crossOriginSubresource";
}

/** What one origin asked for, and what its own policy forbids delegating. */
export type OriginHintPolicy = {
  readonly accepted: readonly string[];
  readonly disabled: readonly string[];
};

/**
 * The hints to actually send on one request: what the origin asked for,
 * narrowed by its permissions policy on subresources, and narrowed again to
 * what this guest can state truthfully.
 *
 * An origin with no record gets nothing. That is the per-origin requirement —
 * high-entropy hints are never broadcast to origins that did not ask.
 */
export function selectNegotiatedHints(
  policy: OriginHintPolicy | null,
  available: GuestClientHints,
  kind: HintRequestKind,
): GuestClientHints {
  if (!policy || kind === "crossOriginSubresource") return {};
  const withheld: ReadonlySet<string> =
    kind === "sameOriginSubresource" ? new Set(policy.disabled) : new Set<string>();
  const selected: Record<string, string> = {};
  for (const name of policy.accepted) {
    if (withheld.has(name)) continue;
    const value = available[name];
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

/** Case-insensitive lookup over Electron's response-header record. */
function pickHeader(
  headers: Readonly<Record<string, string | string[]>>,
  name: string,
): string | string[] | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Remembers which high-entropy hints each origin requested, and answers what to
 * send on a given request.
 *
 * State is bounded to `limit` origins and evicted least-recently-USED, so an
 * origin still being talked to survives a long browsing session while stale ones
 * fall out. One instance is created per session rather than shared, because
 * separate partitions are separate profiles and real Chrome keeps client-hint
 * preferences per profile.
 */
export class ClientHintNegotiator {
  /** Insertion order is recency order; the first key is the eviction victim. */
  private readonly policies = new Map<string, OriginHintPolicy>();
  private readonly available: GuestClientHints;
  private readonly limit: number;

  constructor(available: GuestClientHints, limit: number = DEFAULT_TRACKED_ORIGIN_LIMIT) {
    this.available = available;
    this.limit = Math.max(1, limit);
  }

  /** How many origins are currently remembered. Never exceeds the limit. */
  get trackedOrigins(): number {
    return this.policies.size;
  }

  /**
   * Learn from a response. Only navigation responses are read, which is the
   * scope the spec gives `Accept-CH` and what keeps this map to origins the user
   * actually visited. An origin asking for nothing derivable is not recorded at
   * all, so the map holds no dead entries.
   */
  learnFromResponse(
    url: string,
    resourceType: string,
    responseHeaders: Readonly<Record<string, string | string[]>> | undefined,
  ): void {
    if (!NAVIGATION_RESOURCE_TYPES.has(resourceType)) return;
    if (!responseHeaders) return;
    if (Object.keys(this.available).length === 0) return;
    const origin = httpOrigin(url);
    if (!origin) return;

    const accepted = parseAcceptCh(pickHeader(responseHeaders, "accept-ch"));
    if (accepted.length === 0) return;
    const disabled = clientHintsDisabledByPolicy(pickHeader(responseHeaders, "permissions-policy"));

    // Delete before set so a re-learned origin moves to the recent end.
    this.policies.delete(origin);
    this.policies.set(origin, { accepted, disabled });
    while (this.policies.size > this.limit) {
      const oldest = this.policies.keys().next().value;
      if (oldest === undefined) break;
      this.policies.delete(oldest);
    }
  }

  /** The hints to add to one outgoing request. Empty when nothing is owed. */
  hintsForRequest(
    url: string,
    resourceType: string,
    initiatorUrl: string | null | undefined,
  ): GuestClientHints {
    const origin = httpOrigin(url);
    const policy = origin ? this.touch(origin) : null;
    return selectNegotiatedHints(policy, this.available, classifyHintRequest(resourceType, url, initiatorUrl));
  }

  /** Read an entry and mark it most recently used. */
  private touch(origin: string): OriginHintPolicy | null {
    const policy = this.policies.get(origin);
    if (!policy) return null;
    this.policies.delete(origin);
    this.policies.set(origin, policy);
    return policy;
  }
}

/**
 * The URL of the document that initiated a request, or `null` when it cannot be
 * attributed. Reading `.url` on a frame that has navigated or been destroyed
 * throws, and Electron documents `frame` as possibly null, so both are handled;
 * an unattributed subresource simply receives no high-entropy hints.
 *
 * Measured to be populated for every subresource type (image, xhr) including
 * cross-origin ones, which is what makes the cross-origin check viable. It is
 * empty for a `mainFrame` load — harmless, because navigations are classified
 * without consulting the initiator.
 */
function initiatorUrl(details: { frame?: Electron.WebFrameMain | null }): string | null {
  try {
    return details.frame?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Register the client-hint handling on one session: the unconditional
 * low-entropy fill from PR #248, plus per-origin high-entropy negotiation.
 *
 * Called from `app.on("session-created")` in src/main/main.ts so it reaches
 * every partition, including ones created later by a plugin — the Agent
 * Browser's `persist:agent-browser` does not exist at startup.
 * `session.fromPartition(p).setUserAgent(...)` is *not* used as the UA lever
 * here: it was measured to silently do nothing. The UA is handled process-wide
 * by `app.userAgentFallback`.
 *
 * ## One listener per event, deliberately
 *
 * Electron allows only ONE `onBeforeSendHeaders` listener per session and one
 * `onHeadersReceived`, and registering a second SILENTLY REPLACES the first.
 * Negotiation therefore extends the existing `onBeforeSendHeaders` callback
 * rather than adding another — a second registration here would disable the
 * low-entropy hints this is built on, with no error to show for it. The same
 * applies to the single `onHeadersReceived` that reads `Accept-CH`.
 *
 * Nothing else in Geode registers either event (the only other webRequest use is
 * artifact-runtime's `onBeforeRequest`, a different event), but a plugin that
 * did would replace these.
 */
export function attachGuestClientHints(
  target: Electron.Session,
  hints: GuestClientHints | null,
  highEntropy?: GuestClientHints,
): void {
  const negotiable = highEntropy && Object.keys(highEntropy).length > 0 ? highEntropy : null;
  if (!hints && !negotiable) return;

  // Per session, not shared: separate partitions are separate profiles.
  const negotiator = negotiable ? new ClientHintNegotiator(negotiable) : null;

  if (negotiator) {
    target.webRequest.onHeadersReceived({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      negotiator.learnFromResponse(details.url, details.resourceType, details.responseHeaders);
      // Omitting responseHeaders leaves the response exactly as it arrived.
      callback({});
    });
  }

  target.webRequest.onBeforeSendHeaders({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    let requestHeaders = details.requestHeaders;
    let changed = false;

    if (hints) {
      const merged = addMissingClientHints(requestHeaders, hints);
      if (merged) {
        requestHeaders = merged;
        changed = true;
      }
    }

    if (negotiator) {
      const negotiated = negotiator.hintsForRequest(details.url, details.resourceType, initiatorUrl(details));
      const merged = addMissingClientHints(requestHeaders, negotiated);
      if (merged) {
        requestHeaders = merged;
        changed = true;
      }
    }

    // Omitting requestHeaders leaves the original headers in place.
    callback(changed ? { requestHeaders } : {});
  });
}
