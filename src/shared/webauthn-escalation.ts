/**
 * Passkey/WebAuthn embedded-context escalation signal (Compass roadmap item
 * `c74a2cc6-e20f-42ca-9971-5da985e34fa4`, build package
 * `bap-geode-passkey-webauthn-webviewer-20260917-r2`).
 *
 * Live-code verification (against webauthn.io and Google Sign-In, see the
 * PR description) found that WebAuthn ceremonies generally DO complete
 * inside Geode's embedded `<webview>` — assumption `7919ff78` was not
 * falsified for the relying parties actually tested. This module exists for
 * the providers that DON'T: a relying party can reject a WebAuthn ceremony
 * from inside a non-top-level/embedded context, most commonly by throwing a
 * `NotAllowedError`/`SecurityError` from `navigator.credentials.create()`/
 * `.get()` — the same failure a real Permissions-Policy denial of
 * `publickey-credentials-create`/`-get` produces (Electron 42's Chromium throws
 * `NotAllowedError` for this specific case — verified empirically in
 * tests/e2e/webauthn-escalation.spec.ts rather than assumed from the spec).
 *
 * Deliberately NOT gated by `WEB_VIEWER_CONNECTORS` (web-viewer-connectors.ts):
 * that allowlist exists to scope a small set of *trusted first-party apps*
 * that may post semantically-privileged events (e.g. `agent.handoff`) into
 * the workspace. This channel is the opposite shape — an *infrastructure*
 * signal ("my WebAuthn call was rejected") that must work for ANY relying
 * party the user navigates to, the same way `did-fail-load` already flows
 * unrestricted from any guest to the host. The payload is a fixed, narrow
 * shape (ceremony kind + native error name/message) with no origin-specific
 * trust implied — accepting it from an arbitrary origin cannot grant that
 * origin any capability beyond "the host may now offer the user a
 * top-level-window fallback for this same URL", a user-approved, purely
 * additive escape hatch (see webauthn-escalation.ts in src/main).
 */

/** IPC channel name for the guest-to-main escalation signal. Do not duplicate this string literal elsewhere. */
export const WEBAUTHN_ESCALATION_CHANNEL = "webauthn-escalation-signal";

const MAX_ERROR_MESSAGE_LENGTH = 2048;

export interface WebAuthnEscalationMessage {
  /** Which half of the WebAuthn ceremony failed. */
  ceremony: "create" | "get";
  /** `DOMException.name` from the rejected navigator.credentials call. */
  errorName: string;
  /** `DOMException.message` from the rejected navigator.credentials call. */
  errorMessage: string;
}

export interface NormalizedWebAuthnEscalationSignal extends WebAuthnEscalationMessage {
  url: string;
  timestamp: number;
}

/**
 * Validate and normalize a raw escalation signal from a `<webview>` guest.
 * Returns `null` for anything malformed — the caller (main.ts) drops the
 * message silently in that case, same posture as `normalizeWebViewerEvent`.
 */
export function normalizeWebAuthnEscalationSignal(
  frameUrl: string,
  message: unknown,
): NormalizedWebAuthnEscalationSignal | null {
  let url: URL;
  try {
    url = new URL(frameUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  if (typeof message !== "object" || message === null) return null;
  const { ceremony, errorName, errorMessage } = message as Partial<WebAuthnEscalationMessage>;

  if (ceremony !== "create" && ceremony !== "get") return null;
  if (typeof errorName !== "string" || errorName.length === 0 || errorName.length > 128) return null;
  if (typeof errorMessage !== "string" || errorMessage.length > MAX_ERROR_MESSAGE_LENGTH) return null;

  return { ceremony, errorName, errorMessage, url: frameUrl, timestamp: Date.now() };
}
