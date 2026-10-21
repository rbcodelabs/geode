# GitHub App auth (device flow)

Geode signs a user in to GitHub with the OAuth **device flow** of a GitHub App. No backend and no client secret: the App's client ID is public. Code lives in `src/main/github-auth/`.

## Choosing the App

Layers, highest precedence first (clientId / appSlug come from the first layer that sets them):

1. Environment: `GEODE_GITHUB_CLIENT_ID`, `GEODE_GITHUB_APP_SLUG`
2. Per vault: `<vault>/.geode/app.json`
3. `github` key in `geode.json` (`~/Library/Application Support/Geode/geode.json` on macOS)
4. Built-in default (`geode-rb-code-labs`)

```json
{ "github": { "clientId": "Iv23li…", "appSlug": "bankrate-prototypes", "allowedOwners": ["bankrate-prototypes"], "allowedRepos": ["me/side-project"] } }
```

### From Settings

Settings > GitHub > "GitHub App" edits the `github` key of `geode.json` (slug, client ID, optional allowed owners/repos) without hand-editing. IPC: `github-auth-get-settings` returns the effective values plus the layer each came from (`env` / `vault` / `global` / `default`); `github-auth-set-settings` validates with the same patterns as the parser and **rejects** invalid input (the parser, which guards untrusted files, drops it), preserves other `geode.json` and `github` keys, and removes blank fields. "Use default" removes the whole `github` key. After saving, the form re-checks the App (`GET /apps/{slug}`, uncached) and shows `app_not_found` / `app_mismatch` inline. It also says when an environment variable or the open vault's `.geode/app.json` overrides the saved value, because then the field being edited is not the effective one. Switching to a different client ID drops the stored token (see "Changing the App"), so the user must reconnect. Unchanged: a vault's `.geode/app.json` can still override `clientId`/`appSlug`, and its allowlist can only narrow.

Malformed values in files are ignored. A vault can be authored by someone else, so its allowlist can only **narrow** the global one (every list must pass). Env `GEODE_GITHUB_ALLOWED_OWNERS` / `GEODE_GITHUB_ALLOWED_REPOS` (comma separated) replace the geode.json list.

## Checks before sign-in

- `GET /apps/{slug}` (public) must exist and its `client_id` must match, else `app_not_found` / `app_mismatch`. If GitHub cannot answer, sign-in proceeds.
- `device_flow_disabled` is reported plainly, with a link to the App settings.
- Permissions are compared with what Geode needs (contents write, pull_requests write, metadata/actions/checks read). **Missing** ones warn that features will fail. **Extra** ones warn that agent threads will hold them and require an explicit "Connect anyway" (`confirmation_required`).

## Allowlist

`allowedOwners` / `allowedRepos` filter `listAccess`, make `checkRepo` return `reason: "not_allowed"`, and make `getToken(repo)` refuse. Limitation: a user-to-server token itself is not narrowed. The allowlist limits what Geode reports and hands out, not what the token could do if exfiltrated.

## Changing the App

Stored tokens record the issuing client ID. If the configured App no longer matches, the token is dropped and status becomes `reauth_required`. Tokens saved before this was recorded are assumed to come from the default App.

## Required GitHub App settings

- Device Flow: **enabled**
- Expiring user access tokens: **on** (8h access token, rotating refresh token)
- Webhook: **off**
- Repository permissions: Contents read/write, Pull requests read/write, Actions read, Metadata read
- Installation page slug: see "Choosing the App".

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
