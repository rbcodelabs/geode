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
 * The three hints real Chrome sends on every request and Electron sends on
 * none, keyed by header name.
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

/**
 * Register the client-hint filler on one session.
 *
 * Called from `app.on("session-created")` in src/main/main.ts so it reaches
 * every partition, including ones created later by a plugin — the Agent
 * Browser's `persist:agent-browser` does not exist at startup.
 * `session.fromPartition(p).setUserAgent(...)` is *not* used as the UA lever
 * here: it was measured to silently do nothing. The UA is handled process-wide
 * by `app.userAgentFallback`.
 *
 * Caveat: Electron allows only one `onBeforeSendHeaders` listener per session,
 * so a plugin that registers its own on a guest session would replace this
 * one. Nothing in Geode does (the only other webRequest use is
 * artifact-runtime's `onBeforeRequest`, a different event).
 */
export function attachGuestClientHints(target: Electron.Session, hints: GuestClientHints | null): void {
  if (!hints) return;
  target.webRequest.onBeforeSendHeaders({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    const merged = addMissingClientHints(details.requestHeaders, hints);
    // Omitting requestHeaders leaves the original headers in place.
    callback(merged ? { requestHeaders: merged } : {});
  });
}
