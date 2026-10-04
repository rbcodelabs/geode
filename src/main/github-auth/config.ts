/**
 * Public client ID of the Geode GitHub App. Client IDs are not secrets, and the
 * device flow needs no client secret, so this is safe to ship. Override it in
 * `geode.json` (`github.clientId`), per vault in `.geode/app.json`, or with
 * GEODE_GITHUB_CLIENT_ID.
 */
export const DEFAULT_GITHUB_CLIENT_ID = "Iv23litirg6G1u4PLtEp";

/**
 * URL slug of the App: used for the install link and to verify the client ID
 * against `GET /apps/{slug}` before sign-in. Override like the client ID
 * (`github.appSlug`, GEODE_GITHUB_APP_SLUG).
 */
export const DEFAULT_GITHUB_APP_SLUG = "geode-rb-code-labs";

/** What one config layer (geode.json `github`, `.geode/app.json`) may say. */
export interface GithubAppConfig {
  clientId?: string;
  appSlug?: string;
  /** Owners (users/orgs) agents may reach. Empty/absent = no restriction from this layer. */
  allowedOwners?: string[];
  /** Exact `owner/name` repositories agents may reach. */
  allowedRepos?: string[];
}

/** One restriction. A repo passes when it matches an owner or a repo entry (both empty = passes). */
export interface GithubAllowPolicy {
  owners: string[];
  repos: string[];
}

export interface GithubAppSettings {
  clientId: string;
  appSlug: string;
  /** Every policy must pass, so a vault can narrow the global allowlist but never widen it. */
  allow: GithubAllowPolicy[];
}

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{4,64}$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[\w.-]{1,100}$/;

function str(value: unknown, re: RegExp): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return re.test(v) ? v : undefined;
}

function list(value: unknown, re: RegExp): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((v) => {
    const s = str(v, re);
    return s ? [s] : [];
  });
}

/** Matches no real owner/repo (neither regex admits it), so a bad allowlist fails closed. */
const NO_MATCH = "!none";

/** A non-empty array whose entries are all invalid must restrict everything, not silently open up. */
function allowList(value: unknown, re: RegExp): string[] | undefined {
  const valid = list(value, re);
  if (valid && valid.length === 0 && Array.isArray(value) && value.length > 0) return [NO_MATCH];
  return valid;
}

/**
 * Defensive parse of untrusted JSON (a hand-edited file, or a vault someone
 * else authored). Malformed values are dropped rather than trusted.
 */
export function parseGithubAppConfig(raw: unknown): GithubAppConfig {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: GithubAppConfig = {};
  const clientId = str(obj.clientId, CLIENT_ID_RE);
  const appSlug = str(obj.appSlug, SLUG_RE);
  const owners = allowList(obj.allowedOwners, OWNER_RE);
  const repos = allowList(obj.allowedRepos, REPO_RE);
  if (clientId) out.clientId = clientId;
  if (appSlug) out.appSlug = appSlug;
  if (owners) out.allowedOwners = owners;
  if (repos) out.allowedRepos = repos;
  return out;
}

function envList(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((s) => s.trim()).filter(Boolean);
  return items && items.length ? items : undefined;
}

function policyFrom(owners: string[] | undefined, repos: string[] | undefined): GithubAllowPolicy | null {
  const o = owners ?? [];
  const r = repos ?? [];
  return o.length || r.length ? { owners: o, repos: r } : null;
}

/**
 * Layers, highest precedence first: environment variables, then
 * `.geode/app.json` in the open vault, then `github` in `geode.json`, then the
 * built-in default. clientId/appSlug come from the highest layer that sets
 * them. Allowlists differ on purpose: env replaces the geode.json list, but a
 * vault's list is ANDed on top, so opening an untrusted vault can only
 * narrow where agents reach.
 */
export function resolveGithubAppSettings(
  layers: { env?: Record<string, string | undefined>; global?: unknown; vault?: unknown } = {},
): GithubAppSettings {
  const env = layers.env ?? process.env;
  const global = parseGithubAppConfig(layers.global);
  const vault = parseGithubAppConfig(layers.vault);
  const envOwners = envList(env.GEODE_GITHUB_ALLOWED_OWNERS);
  const envRepos = envList(env.GEODE_GITHUB_ALLOWED_REPOS);
  const base = envOwners || envRepos
    ? policyFrom(envOwners, envRepos)
    : policyFrom(global.allowedOwners, global.allowedRepos);
  const vaultPolicy = policyFrom(vault.allowedOwners, vault.allowedRepos);
  return {
    clientId: env.GEODE_GITHUB_CLIENT_ID?.trim() || vault.clientId || global.clientId || DEFAULT_GITHUB_CLIENT_ID,
    appSlug: env.GEODE_GITHUB_APP_SLUG?.trim() || vault.appSlug || global.appSlug || DEFAULT_GITHUB_APP_SLUG,
    allow: [base, vaultPolicy].filter((p): p is GithubAllowPolicy => p !== null),
  };
}

/** Back-compat helpers (env + defaults only). */
export function resolveGithubClientId(env: Record<string, string | undefined> = process.env): string {
  return resolveGithubAppSettings({ env }).clientId;
}

export function resolveGithubAppSlug(env: Record<string, string | undefined> = process.env): string {
  return resolveGithubAppSettings({ env }).appSlug;
}

export function isRepoAllowed(allow: GithubAllowPolicy[], repoFullName: string): boolean {
  const full = repoFullName.toLowerCase();
  const owner = full.split("/")[0];
  return allow.every(
    (p) => p.owners.some((o) => o.toLowerCase() === owner) || p.repos.some((r) => r.toLowerCase() === full),
  );
}

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_REVOKE_PAGE_URL = "https://github.com/settings/applications";
