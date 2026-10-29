export const ARTIFACT_SCHEME = "geode-artifact";

export const STATIC_ARTIFACT_CSP = [
  "default-src 'none'",
  `script-src ${ARTIFACT_SCHEME}:`,
  `style-src ${ARTIFACT_SCHEME}: 'unsafe-inline'`,
  `img-src ${ARTIFACT_SCHEME}: data: blob:`,
  `font-src ${ARTIFACT_SCHEME}: data:`,
  `media-src ${ARTIFACT_SCHEME}: blob:`,
  "connect-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Dev-only CSP for Next.js artifacts (see ADR 0005). Inline/eval script is a
 * dev-server necessity (React Refresh, webpack eval devtool); the request
 * filter, not this header, remains the authoritative network boundary.
 */
export function nextjsArtifactCsp(origin: string): string {
  const wsOrigin = origin.replace(/^http:/, "ws:");
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${wsOrigin}`,
    "child-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}

export const DEV_SERVER_MIN_PORT = 1024;
export const DEV_SERVER_MAX_PORT = 65535;

export type LoopbackDevServerUrlResult =
  | { ok: true; /** e.g. http://127.0.0.1:3000 */ origin: string; /** origin + "/" */ url: string }
  | { ok: false; reason: string };

const LOOPBACK_URL_PATTERN = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/;

/**
 * Validate a producer-supplied dev server URL. Deliberately stricter than URL
 * parsing: the raw string must be exactly http://127.0.0.1:<port>[/], so
 * alternate loopback spellings, credentials, queries and fragments never reach
 * the request filter.
 */
export function parseLoopbackDevServerUrl(raw: unknown): LoopbackDevServerUrlResult {
  if (typeof raw !== "string") return { ok: false, reason: "Dev server URL must be a string." };
  const match = LOOPBACK_URL_PATTERN.exec(raw);
  if (!match) {
    return { ok: false, reason: "Dev server URL must be http://127.0.0.1:<port>/ with no credentials, path, query, or fragment." };
  }
  const port = Number(match[1]);
  if (port < DEV_SERVER_MIN_PORT || port > DEV_SERVER_MAX_PORT) {
    return { ok: false, reason: `Dev server port must be between ${DEV_SERVER_MIN_PORT} and ${DEV_SERVER_MAX_PORT}.` };
  }
  const origin = `http://127.0.0.1:${port}`;
  return { ok: true, origin, url: `${origin}/` };
}

export type ArtifactUrlUse = "document" | "subresource";

/**
 * Authoritative request filter. Static artifacts: own geode-artifact origin
 * (plus inert data:/blob: subresources). With `allowedOrigin` (Next.js
 * runtime) the policy is replaced: only that exact http origin and its ws
 * twin are allowed, plus the same inert data:/blob: subresources. The
 * geode-artifact scheme is not served for such artifacts, so it is denied.
 */
export function isArtifactUrlAllowed(
  rawUrl: string,
  artifactId: string,
  use: ArtifactUrlUse,
  allowedOrigin?: string,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (allowedOrigin !== undefined) {
    let allowed: URL;
    try {
      allowed = new URL(allowedOrigin);
    } catch {
      return false;
    }
    if (url.protocol === "http:" || url.protocol === "ws:") {
      return url.hostname === allowed.hostname && url.port === allowed.port
        && url.username === "" && url.password === "";
    }
    return use === "subresource" && ["data:", "blob:"].includes(url.protocol);
  }

  if (url.protocol === `${ARTIFACT_SCHEME}:`) {
    return url.hostname === artifactId && url.username === "" && url.password === "";
  }
  if (use === "subresource" && ["data:", "blob:"].includes(url.protocol)) return true;
  return false;
}
