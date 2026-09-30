/**
 * Public client ID of the Geode GitHub App. Client IDs are not secrets, and the
 * device flow needs no client secret, so this is safe to ship. Override with
 * GEODE_GITHUB_CLIENT_ID to point a build at a different App (e.g. for testing).
 */
export const DEFAULT_GITHUB_CLIENT_ID = "Iv23litirg6G1u4PLtEp";

/**
 * URL slug of the App, used only to build the "install on this repo" link.
 * Unverified guess; override with GEODE_GITHUB_APP_SLUG.
 */
export const DEFAULT_GITHUB_APP_SLUG = "geode";

export function resolveGithubClientId(env: Record<string, string | undefined> = process.env): string {
  const override = env.GEODE_GITHUB_CLIENT_ID?.trim();
  return override ? override : DEFAULT_GITHUB_CLIENT_ID;
}

export function resolveGithubAppSlug(env: Record<string, string | undefined> = process.env): string {
  const override = env.GEODE_GITHUB_APP_SLUG?.trim();
  return override ? override : DEFAULT_GITHUB_APP_SLUG;
}

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_REVOKE_PAGE_URL = "https://github.com/settings/applications";
