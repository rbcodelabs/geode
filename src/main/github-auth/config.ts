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

export type GithubSettingSource = "env" | "vault" | "global" | "default";

export interface GithubSettingsView {
  clientId: { value: string; source: GithubSettingSource };
  appSlug: { value: string; source: GithubSettingSource };
  /** What geode.json itself holds (the layer the Settings form edits), even when a higher layer wins. */
  global: GithubAppConfig;
  /** Layers that set a value above geode.json, so the UI can say the edited field is not the effective one. */
  overriddenBy: { clientId: GithubSettingSource | null; appSlug: GithubSettingSource | null };
  allowSources: { env: boolean; global: boolean; vault: boolean };
  defaults: { clientId: string; appSlug: string };
}

/** Effective App settings plus which layer each value came from. Mirrors resolveGithubAppSettings. */
export function describeGithubAppSettings(
  layers: { env?: Record<string, string | undefined>; global?: unknown; vault?: unknown } = {},
): GithubSettingsView {
  const env = layers.env ?? process.env;
  const global = parseGithubAppConfig(layers.global);
  const vault = parseGithubAppConfig(layers.vault);
  const pick = (envValue: string | undefined, v: string | undefined, g: string | undefined, d: string) => {
    const e = envValue?.trim();
    if (e) return { value: e, source: "env" as const };
    if (v) return { value: v, source: "vault" as const };
    if (g) return { value: g, source: "global" as const };
    return { value: d, source: "default" as const };
  };
  const clientId = pick(env.GEODE_GITHUB_CLIENT_ID, vault.clientId, global.clientId, DEFAULT_GITHUB_CLIENT_ID);
  const appSlug = pick(env.GEODE_GITHUB_APP_SLUG, vault.appSlug, global.appSlug, DEFAULT_GITHUB_APP_SLUG);
  const above = (s: { source: GithubSettingSource }) => (s.source === "env" || s.source === "vault" ? s.source : null);
  return {
    clientId,
    appSlug,
    global,
    overriddenBy: { clientId: above(clientId), appSlug: above(appSlug) },
    allowSources: {
      env: !!(envList(env.GEODE_GITHUB_ALLOWED_OWNERS) || envList(env.GEODE_GITHUB_ALLOWED_REPOS)),
      global: !!policyFrom(global.allowedOwners, global.allowedRepos),
      vault: !!policyFrom(vault.allowedOwners, vault.allowedRepos),
    },
    defaults: { clientId: DEFAULT_GITHUB_CLIENT_ID, appSlug: DEFAULT_GITHUB_APP_SLUG },
  };
}

/** What the Settings form submits. A blank/absent field means "use the default" (key removed). */
export interface GithubAppSettingsInput {
  clientId?: string;
  appSlug?: string;
  allowedOwners?: string[];
  allowedRepos?: string[];
}

export type GithubAppSettingsUpdate =
  | { ok: true; github: GithubAppConfig | undefined }
  | { ok: false; errors: Partial<Record<keyof GithubAppSettingsInput, string>> };

function checkOne(value: unknown, re: RegExp, label: string): { value?: string; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") return { error: `${label} must be text.` };
  const v = value.trim();
  if (!v) return {};
  return re.test(v) ? { value: v } : { error: `"${v}" is not a valid ${label}.` };
}

function checkList(value: unknown, re: RegExp, label: string): { value?: string[]; error?: string } {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) return { error: `${label} must be a list.` };
  const out: string[] = [];
  for (const item of value) {
    const v = typeof item === "string" ? item.trim() : "";
    if (!v) continue;
    if (!re.test(v)) return { error: `"${v}" is not a valid ${label}.` };
    if (!out.includes(v)) out.push(v);
  }
  return out.length ? { value: out } : {};
}

/**
 * Validates a Settings submission and merges it into the existing geode.json
 * `github` value. Invalid input is rejected (never silently dropped, unlike
 * parseGithubAppConfig, which guards untrusted files). Unknown keys already in
 * `github` are preserved. `github: undefined` means the whole key should be removed.
 */
export function applyGithubAppSettingsInput(existing: unknown, input: unknown): GithubAppSettingsUpdate {
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  if (!obj) return { ok: false, errors: { clientId: "Invalid settings." } };
  const errors: Partial<Record<keyof GithubAppSettingsInput, string>> = {};
  const clientId = checkOne(obj.clientId, CLIENT_ID_RE, "client ID");
  const appSlug = checkOne(obj.appSlug, SLUG_RE, "app slug");
  const owners = checkList(obj.allowedOwners, OWNER_RE, "owner");
  const repos = checkList(obj.allowedRepos, REPO_RE, "repository (owner/name)");
  if (clientId.error) errors.clientId = clientId.error;
  if (appSlug.error) errors.appSlug = appSlug.error;
  if (owners.error) errors.allowedOwners = owners.error;
  if (repos.error) errors.allowedRepos = repos.error;
  if (Object.keys(errors).length) return { ok: false, errors };

  const next: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  const set = (key: string, value: unknown) => {
    if (value === undefined) delete next[key];
    else next[key] = value;
  };
  set("clientId", clientId.value);
  set("appSlug", appSlug.value);
  // Lists are only touched when the caller sent them, so a form without list fields keeps them.
  if ("allowedOwners" in obj) set("allowedOwners", owners.value);
  if ("allowedRepos" in obj) set("allowedRepos", repos.value);
  return { ok: true, github: Object.keys(next).length ? (next as GithubAppConfig) : undefined };
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
