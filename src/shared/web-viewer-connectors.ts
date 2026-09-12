/**
 * Registry of trusted "connector" web apps allowed to post events out of the
 * Web Viewer's `<webview>` guest, via `window.__geode.postEvent(type, payload)`
 * (see src/main/webviewer-bridge-preload.ts). Framework-agnostic and free of
 * Electron imports so it can be shared by the main-process build and the
 * renderer/mobile build alike (matching src/shared/root-registry.ts).
 *
 * Origin checking happens here, authoritatively, in the main process — never
 * trust a hostname or connector id the guest page claims about itself.
 */
export interface WebViewerConnector {
  id: string;
  hostname: string;
  allowedEventTypes: readonly string[];
}

export const WEB_VIEWER_CONNECTORS: readonly WebViewerConnector[] = [
  { id: "compass", hostname: "compass.rbcodelabs.com", allowedEventTypes: ["decision.approved"] },
];

/**
 * Exact hostname match only — no wildcard or subdomain matching. Confusables
 * like `evilcompass.rbcodelabs.com` (prefix) or
 * `compass.rbcodelabs.com.evil.com` (suffix) must not resolve.
 *
 * Known gap (tracked as a follow-up, not fixed here): this checks hostname
 * only, not scheme, so `http://compass.rbcodelabs.com` resolves the same
 * connector as `https://`. Enforcing `https:` for real connector traffic
 * while still allowing the E2E suite's local `http://compass.rbcodelabs.com:
 * <port>` fixture (via `--host-resolver-rules`, which only redirects DNS,
 * not scheme) would need either a scheme-aware loopback check at the
 * network layer (not available to this pure, framework-agnostic module) or
 * a real TLS test fixture — deferred rather than rushed into a
 * security-sensitive path.
 */
export function resolveWebViewerConnector(frameUrl: string): WebViewerConnector | null {
  let hostname: string;
  try {
    hostname = new URL(frameUrl).hostname;
  } catch {
    return null;
  }
  return WEB_VIEWER_CONNECTORS.find((connector) => connector.hostname === hostname) ?? null;
}

export interface WebViewerBridgeMessage {
  type: string;
  payload: unknown;
}

export interface NormalizedWebViewerEvent {
  source: string;
  type: string;
  payload: unknown;
  url: string;
  timestamp: number;
}

/** IPC channel name for the guest-to-main bridge. Do not duplicate this string literal elsewhere. */
export const WEBVIEWER_BRIDGE_CHANNEL = "webviewer-bridge-event";

const MAX_PAYLOAD_JSON_LENGTH = 8192;

/**
 * Structural equality used to confirm a JSON.stringify/JSON.parse round-trip
 * did not silently lose data. Plain `JSON.stringify` never throws for a
 * function-valued *property* (it just omits the key), so a try/catch around
 * the round-trip alone would let `{ fn: () => {} }` through unchanged in
 * spirit but silently stripped in fact. Comparing before/after catches that
 * (and NaN/Infinity/undefined/Date-style lossy conversions) without needing
 * a bespoke walk of every JS type that JSON can't represent faithfully.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/**
 * Resolve, validate, and normalize a raw bridge message from a `<webview>`
 * guest. Returns `null` for anything that fails an origin, event-type,
 * serializability, or size check — the caller (main.ts) drops the message
 * silently in that case rather than forwarding it to the workspace bus.
 */
export function normalizeWebViewerEvent(
  frameUrl: string,
  message: WebViewerBridgeMessage,
): NormalizedWebViewerEvent | null {
  const connector = resolveWebViewerConnector(frameUrl);
  if (!connector) return null;

  if (typeof message.type !== "string" || !connector.allowedEventTypes.includes(message.type)) {
    return null;
  }

  // The preload's postEvent(type, payload?) makes payload optional; normalize
  // undefined to null up front so an omitted payload round-trips cleanly
  // instead of being rejected by the serializability check below purely
  // because `JSON.stringify(undefined)` isn't a string.
  const payloadForValidation = message.payload === undefined ? null : message.payload;

  let serialized: string;
  let parsedBack: unknown;
  try {
    serialized = JSON.stringify(payloadForValidation);
    if (typeof serialized !== "string") return null;
    parsedBack = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (serialized.length > MAX_PAYLOAD_JSON_LENGTH) return null;
  if (!deepEqual(payloadForValidation, parsedBack)) return null;

  return {
    source: connector.id,
    type: message.type,
    payload: parsedBack,
    url: frameUrl,
    timestamp: Date.now(),
  };
}
