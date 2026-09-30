# GitHub App auth (device flow)

Geode signs a user in to GitHub with the OAuth **device flow** of a GitHub App. No backend and no client secret: the App's client ID is public (`Iv23litirg6G1u4PLtEp`, overridable with `GEODE_GITHUB_CLIENT_ID`). Code lives in `src/main/github-auth/`.

## Required GitHub App settings

- Device Flow: **enabled**
- Expiring user access tokens: **on** (8h access token, rotating refresh token)
- Webhook: **off**
- Repository permissions: Contents read/write, Pull requests read/write, Actions read, Metadata read
- The install page slug is read from `GEODE_GITHUB_APP_SLUG` (default `geode`); set it to the App's real slug.

## Flow

1. `POST github.com/login/device/code` returns `user_code`, `verification_uri`, `interval`.
2. Settings > GitHub shows the code and opens the verification URL (skipped under `GEODE_HEADLESS`).
3. Main polls `login/oauth/access_token` with the device-code grant, honoring `interval`, `slow_down` (use GitHub's new interval, else +5s), `authorization_pending`; `expired_token` and `access_denied` end the attempt.
4. Tokens are stored; the account login is fetched from `/user`.

## Storage and refresh

- Tokens are encrypted with Electron `safeStorage` via `SecretStore`, in their own file `userData/github-auth.json` (not the plugin-visible `secrets.json`, never in the vault or config). With no OS keychain, sign-in is refused rather than falling back to plaintext.
- Access and refresh tokens are one JSON value, so each refresh rotation is a single atomic file replace.
- `GithubAuthService.getAccessToken()` refreshes when within 5 minutes of expiry (single-flight, since refresh tokens are one-shot) and on a 401 from the API. A rejected refresh clears the tokens and reports `reauth_required`; a network or 5xx failure keeps them.
- Tokens are **not** injected globally. A thread or terminal asks for one on demand (`window.geode.githubAuth.getToken()`) and sets `GH_TOKEN` itself.

## Installations

`GET /user/installations` and `/user/installations/{id}/repositories` list what the App can reach. `checkRepo("owner/name")` reports coverage and, when uncovered, `https://github.com/apps/<slug>/installations/new`.

## Disconnect

Deletes the local tokens. Revoking needs the client secret, which we do not have, so the UI links to `https://github.com/settings/applications` and the revoke API is never called.

## Testing

All network goes through an injected `GithubHttp`; `tests/unit/github-auth.test.ts` uses a fake GitHub and an injected clock/sleep.
