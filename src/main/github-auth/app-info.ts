import { GITHUB_API_BASE } from "./config";
import { asRecord, type GithubHttp } from "./http";

export interface GithubAppInfo {
  slug: string;
  name: string;
  clientId: string | null;
  ownerLogin: string | null;
  ownerType: string | null;
  htmlUrl: string;
  /** Permission name -> "read" | "write" | "admin". */
  permissions: Record<string, string>;
}

/** Fetch result: the App, or why it could not be confirmed. */
export type GithubAppLookup =
  | { kind: "found"; app: GithubAppInfo }
  | { kind: "not_found" }
  | { kind: "unavailable"; message: string };

/** `GET /apps/{slug}` is public (no token), so this works before sign-in. */
export async function fetchAppInfo(http: GithubHttp, slug: string): Promise<GithubAppLookup> {
  let res;
  try {
    res = await http({
      method: "GET",
      url: `${GITHUB_API_BASE}/apps/${encodeURIComponent(slug)}`,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
  } catch (error) {
    return { kind: "unavailable", message: `Could not reach GitHub: ${(error as Error).message}` };
  }
  if (res.status === 404) return { kind: "not_found" };
  const body = asRecord(res.json);
  if (res.status !== 200 || typeof body.slug !== "string") {
    return { kind: "unavailable", message: `GitHub returned HTTP ${res.status} for the App lookup.` };
  }
  const owner = asRecord(body.owner);
  const permissions: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(body.permissions))) if (typeof v === "string") permissions[k] = v;
  return {
    kind: "found",
    app: {
      slug: body.slug,
      name: typeof body.name === "string" ? body.name : body.slug,
      clientId: typeof body.client_id === "string" ? body.client_id : null,
      ownerLogin: typeof owner.login === "string" ? owner.login : null,
      ownerType: typeof owner.type === "string" ? owner.type : null,
      htmlUrl: typeof body.html_url === "string" ? body.html_url : `https://github.com/apps/${slug}`,
      permissions,
    },
  };
}

/** Where the App owner turns Device Flow on (org-owned Apps live under the org). */
export function appSettingsUrl(app: Pick<GithubAppInfo, "slug" | "ownerLogin" | "ownerType"> | null, slug: string): string {
  const s = encodeURIComponent(app?.slug ?? slug);
  return app?.ownerType === "Organization" && app.ownerLogin
    ? `https://github.com/organizations/${encodeURIComponent(app.ownerLogin)}/settings/apps/${s}`
    : `https://github.com/settings/apps/${s}`;
}

/** What Geode needs to open PRs and read CI; anything beyond this is power agent threads would hold. */
export const REQUIRED_PERMISSIONS: Record<string, "read" | "write"> = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  actions: "read",
  checks: "read",
};

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

export interface PermissionReport {
  /** Needed but absent or too weak: the feature will fail. */
  missing: { permission: string; needed: string; have: string | null }[];
  /** Granted beyond need: agent threads would hold these powers. */
  extra: { permission: string; level: string; needed: string | null }[];
}

export function assessPermissions(granted: Record<string, string>): PermissionReport {
  const missing: PermissionReport["missing"] = [];
  const extra: PermissionReport["extra"] = [];
  for (const [permission, needed] of Object.entries(REQUIRED_PERMISSIONS)) {
    const have = granted[permission] ?? null;
    if (!have || (RANK[have] ?? 0) < RANK[needed]) missing.push({ permission, needed, have });
    else if (RANK[have] > RANK[needed]) extra.push({ permission, level: have, needed });
  }
  for (const [permission, level] of Object.entries(granted)) {
    if (!(permission in REQUIRED_PERMISSIONS)) extra.push({ permission, level, needed: null });
  }
  return { missing, extra };
}
