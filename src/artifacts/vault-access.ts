/**
 * Pure policy for the opt-in artifact vault bridge (see the Compass "ADR - Artifact vault read bridge"). No Electron,
 * DOM, or vault imports: the manifest parser, the renderer-side bridge, and
 * unit tests all share this one definition of "what may an artifact query".
 */

/** Hard ceilings, enforced host-side regardless of what the guest asks for. */
export const VAULT_ALLOWLIST_MAX_ENTRIES = 32;
export const VAULT_ALLOWLIST_ENTRY_MAX_LENGTH = 256;
export const VAULT_QUERY_MAX_BASE_PATH_LENGTH = 512;
export const VAULT_QUERY_MAX_VIEW_NAME_LENGTH = 200;
export const VAULT_QUERY_DEFAULT_ROW_LIMIT = 500;
export const VAULT_QUERY_MAX_ROW_LIMIT = 1000;

export type VaultPathIssue = "empty" | "too_long" | "absolute" | "backslash" | "control" | "drive_letter" | "dot_segment" | "empty_segment";

/**
 * Normalize an untrusted vault-relative path. Never "fixes" a suspicious path
 * (no collapsing of `..`): anything that is not already a portable relative
 * path is rejected so traversal attempts surface as errors.
 */
export function normalizeVaultRelativePath(
  raw: unknown,
  options: { maxLength?: number; allowTrailingSlash?: boolean } = {},
): { ok: true; path: string } | { ok: false; issue: VaultPathIssue } {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, issue: "empty" };
  if (raw.length > (options.maxLength ?? VAULT_QUERY_MAX_BASE_PATH_LENGTH)) return { ok: false, issue: "too_long" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, issue: "control" };
  if (raw.includes("\\")) return { ok: false, issue: "backslash" };
  if (raw.startsWith("/")) return { ok: false, issue: "absolute" };
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, issue: "drive_letter" };
  const trailingSlash = raw.endsWith("/");
  if (trailingSlash && !options.allowTrailingSlash) return { ok: false, issue: "empty_segment" };
  const body = trailingSlash ? raw.slice(0, -1) : raw;
  const segments = body.split("/");
  for (const segment of segments) {
    if (segment === "") return { ok: false, issue: "empty_segment" };
    if (segment === "." || segment === "..") return { ok: false, issue: "dot_segment" };
    // Percent-encoded and unicode-dot tricks are not interpreted by the vault
    // lookup (exact path map), so they cannot traverse; they simply won't match.
  }
  return { ok: true, path: raw };
}

/** Validate one manifest `vaultAllowlist` entry. Returns an error message or null. */
export function validateVaultAllowlistEntry(entry: unknown): string | null {
  const normalized = normalizeVaultRelativePath(entry, {
    maxLength: VAULT_ALLOWLIST_ENTRY_MAX_LENGTH,
    allowTrailingSlash: true,
  });
  if (!normalized.ok) {
    return `Allowlist entry must be a portable vault-relative path (rejected: ${normalized.issue}).`;
  }
  if (normalized.path === "**" || normalized.path === "**/*" || normalized.path === "*") {
    return "Allowlist entry is too broad; name a folder or .base file.";
  }
  return null;
}

function segmentToRegExpSource(segment: string): string {
  return segment
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
}

/**
 * Entry grammar:
 *  - `Folder/`          prefix: everything beneath Folder
 *  - `a/b.base`         exact path (case-sensitive)
 *  - `*` within a segment matches any characters except `/`
 *  - a `**` segment matches zero or more whole segments (`Projects/**`, `**\/*.base`)
 */
function compileEntry(entry: string): RegExp {
  const pattern = entry.endsWith("/") ? `${entry}**` : entry;
  const parts = pattern.split("/");
  let source = "^";
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (part === "**") {
      source += last ? ".*" : "(?:[^/]+/)*";
    } else {
      source += segmentToRegExpSource(part) + (last ? "" : "/");
    }
  });
  return new RegExp(`${source}$`);
}

export interface VaultAllowlist {
  readonly entries: readonly string[];
  matches(vaultPath: string): boolean;
}

export function compileVaultAllowlist(entries: readonly string[]): VaultAllowlist {
  const compiled = entries.map(compileEntry);
  return {
    entries: [...entries],
    matches(vaultPath: string): boolean {
      return compiled.some((re) => re.test(vaultPath));
    },
  };
}

// ---------------------------------------------------------------------------
// Guest request validation

export interface VaultQueryRequest {
  /** Vault-relative path of a `.base` file. */
  base: string;
  /** View name inside the base. Defaults to the first view. */
  view?: string;
  /** Maximum rows to return (clamped to VAULT_QUERY_MAX_ROW_LIMIT). */
  limit: number;
}

export type VaultQueryErrorCode =
  | "bad_request"
  | "not_allowed"
  | "not_found"
  | "invalid_base"
  | "query_failed"
  | "too_many_requests"
  | "unavailable";

export interface VaultQueryError {
  error: { code: VaultQueryErrorCode; message: string };
}

export function vaultQueryError(code: VaultQueryErrorCode, message: string): VaultQueryError {
  return { error: { code, message } };
}

/** Validate the guest-supplied request shape. Never throws. */
export function parseVaultQueryRequest(raw: unknown): { ok: true; request: VaultQueryRequest } | ({ ok: false } & VaultQueryError) {
  const bad = (message: string) => ({ ok: false as const, ...vaultQueryError("bad_request", message) });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("Request must be an object.");
  const input = raw as Record<string, unknown>;
  const known = new Set(["base", "view", "limit"]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) return bad(`Unknown request field "${key}". Only inline-free queries of an allowed .base file are supported.`);
  }
  const base = normalizeVaultRelativePath(input.base, { maxLength: VAULT_QUERY_MAX_BASE_PATH_LENGTH });
  if (!base.ok) return bad(`Invalid "base" path (${base.issue}).`);
  if (!base.path.endsWith(".base")) return bad('"base" must name a .base file.');
  let view: string | undefined;
  if (input.view !== undefined) {
    if (typeof input.view !== "string" || input.view.length === 0 || input.view.length > VAULT_QUERY_MAX_VIEW_NAME_LENGTH) {
      return bad('"view" must be a non-empty string.');
    }
    view = input.view;
  }
  let limit = VAULT_QUERY_DEFAULT_ROW_LIMIT;
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1) {
      return bad('"limit" must be a positive integer.');
    }
    limit = Math.min(input.limit, VAULT_QUERY_MAX_ROW_LIMIT);
  }
  return { ok: true, request: { base: base.path, view, limit } };
}
