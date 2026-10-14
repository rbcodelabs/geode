import { GITHUB_ACCESS_TOKEN_URL, GITHUB_DEVICE_CODE_URL } from "./config";
import { asRecord, type GithubHttp } from "./http";

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCodeInfo {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms; null when GitHub issued a non-expiring token. */
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
}

export type GithubAuthErrorCode =
  | "expired_token"
  | "access_denied"
  | "reauth_required"
  | "network"
  | "device_flow_disabled"
  | "app_not_found"
  | "app_mismatch"
  | "confirmation_required"
  | "not_allowed"
  | "unexpected";

export class GithubAuthError extends Error {
  /** A page the user can open to fix the problem (e.g. the App settings). */
  constructor(readonly code: GithubAuthErrorCode, message: string, readonly url?: string) {
    super(message);
    this.name = "GithubAuthError";
  }
}

export async function requestDeviceCode(
  http: GithubHttp,
  clientId: string,
  /** Where to send the user if the App has Device Flow off. */
  settingsUrl?: string,
): Promise<DeviceCodeInfo> {
  const res = await http({ method: "POST", url: GITHUB_DEVICE_CODE_URL, form: { client_id: clientId } });
  const body = asRecord(res.json);
  if (body.error === "device_flow_disabled") {
    throw new GithubAuthError(
      "device_flow_disabled",
      "Device Flow is turned off for this GitHub App. Ask the App owner to enable it under \"Optional features\" / \"Enable Device Flow\" in the App settings.",
      settingsUrl,
    );
  }
  if (res.status !== 200 || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    const detail = typeof body.error_description === "string" ? body.error_description : `HTTP ${res.status}`;
    throw new GithubAuthError("unexpected", `GitHub device code request failed: ${detail}`);
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri:
      typeof body.verification_uri === "string" ? body.verification_uri : "https://github.com/login/device",
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
    interval: typeof body.interval === "number" ? body.interval : 5,
  };
}

/** Parse a successful token response; null when it has no access token. */
export function parseTokenResponse(json: unknown, now: number): TokenSet | null {
  const body = asRecord(json);
  if (typeof body.access_token !== "string" || !body.access_token) return null;
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
  const refreshExpiresIn = typeof body.refresh_token_expires_in === "number" ? body.refresh_token_expires_in : null;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    accessTokenExpiresAt: expiresIn == null ? null : now + expiresIn * 1000,
    refreshTokenExpiresAt: refreshExpiresIn == null ? null : now + refreshExpiresIn * 1000,
  };
}

export interface PollOptions {
  http: GithubHttp;
  clientId: string;
  device: DeviceCodeInfo;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  signal?: AbortSignal;
}

/** Poll until the user authorizes, honoring interval/slow_down. Throws GithubAuthError otherwise. */
export async function pollForToken(opts: PollOptions): Promise<TokenSet> {
  const { http, clientId, device, sleep, now, signal } = opts;
  let intervalSeconds = device.interval;
  const deadline = now() + device.expiresIn * 1000;
  for (;;) {
    await sleep(intervalSeconds * 1000);
    if (signal?.aborted) throw new GithubAuthError("access_denied", "Sign-in cancelled");
    if (now() >= deadline) throw new GithubAuthError("expired_token", "The device code expired. Start again.");
    const res = await http({
      method: "POST",
      url: GITHUB_ACCESS_TOKEN_URL,
      form: { client_id: clientId, device_code: device.deviceCode, grant_type: DEVICE_GRANT_TYPE },
    });
    const tokens = parseTokenResponse(res.json, now());
    if (tokens) return tokens;
    const body = asRecord(res.json);
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        // GitHub supplies the new interval; otherwise the spec says add 5s.
        intervalSeconds = typeof body.interval === "number" ? body.interval : intervalSeconds + 5;
        continue;
      case "expired_token":
        throw new GithubAuthError("expired_token", "The device code expired. Start again.");
      case "access_denied":
        throw new GithubAuthError("access_denied", "Authorization was denied.");
      default:
        throw new GithubAuthError(
          "unexpected",
          `GitHub sign-in failed: ${typeof body.error === "string" ? body.error : `HTTP ${res.status}`}`,
        );
    }
  }
}

/**
 * Exchange a refresh token. GitHub rotates refresh tokens, so the returned set
 * carries a NEW refresh token that must be persisted before the old one is
 * forgotten. A rejected refresh is `reauth_required`; transport/5xx failures
 * are `network` (retryable, must not discard stored credentials).
 */
export async function refreshTokens(
  http: GithubHttp,
  clientId: string,
  refreshToken: string,
  now: number,
): Promise<TokenSet> {
  let res;
  try {
    res = await http({
      method: "POST",
      url: GITHUB_ACCESS_TOKEN_URL,
      form: { client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken },
    });
  } catch (error) {
    throw new GithubAuthError("network", `Could not reach GitHub: ${(error as Error).message}`);
  }
  if (res.status >= 500) throw new GithubAuthError("network", `GitHub returned HTTP ${res.status}`);
  const tokens = parseTokenResponse(res.json, now);
  if (!tokens || !tokens.refreshToken) {
    throw new GithubAuthError("reauth_required", "GitHub sign-in expired. Connect GitHub again.");
  }
  return tokens;
}
