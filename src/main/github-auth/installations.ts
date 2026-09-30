import { GITHUB_API_BASE } from "./config";
import { asRecord, type GithubHttp } from "./http";

export interface GithubRepo {
  id: number;
  fullName: string;
  private: boolean;
}

export interface GithubInstallation {
  id: number;
  account: string;
  repositories: GithubRepo[];
}

export interface RepoCoverage {
  covered: boolean;
  installationId: number | null;
  /** Where the user can grant the App access when `covered` is false. */
  installUrl: string | null;
}

/** Thrown when GitHub rejects the access token (401), so callers can refresh and retry. */
export class GithubUnauthorizedError extends Error {}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function getJson(http: GithubHttp, token: string, path: string): Promise<Record<string, unknown>> {
  const res = await http({ method: "GET", url: `${GITHUB_API_BASE}${path}`, headers: apiHeaders(token) });
  if (res.status === 401) throw new GithubUnauthorizedError("GitHub rejected the access token");
  if (res.status !== 200) throw new Error(`GitHub API ${path} failed: HTTP ${res.status}`);
  return asRecord(res.json);
}

export async function fetchViewerLogin(http: GithubHttp, token: string): Promise<string | null> {
  const body = await getJson(http, token, "/user");
  return typeof body.login === "string" ? body.login : null;
}

export async function listInstallations(http: GithubHttp, token: string): Promise<GithubInstallation[]> {
  const body = await getJson(http, token, "/user/installations?per_page=100");
  const raw = Array.isArray(body.installations) ? body.installations : [];
  const result: GithubInstallation[] = [];
  for (const item of raw) {
    const inst = asRecord(item);
    if (typeof inst.id !== "number") continue;
    const repos = await getJson(http, token, `/user/installations/${inst.id}/repositories?per_page=100`);
    const login = asRecord(inst.account).login;
    result.push({
      id: inst.id,
      account: typeof login === "string" ? login : "unknown",
      repositories: (Array.isArray(repos.repositories) ? repos.repositories : []).flatMap((r) => {
        const repo = asRecord(r);
        if (typeof repo.id !== "number" || typeof repo.full_name !== "string") return [];
        return [{ id: repo.id, fullName: repo.full_name, private: repo.private === true }];
      }),
    });
  }
  return result;
}

/**
 * Is `owner/name` reachable through any installation? When not, `installUrl`
 * points at the App's install page, which is where the user grants access.
 */
export function checkRepoCoverage(
  installations: GithubInstallation[],
  repoFullName: string,
  appSlug: string,
): RepoCoverage {
  const wanted = repoFullName.toLowerCase();
  for (const inst of installations) {
    if (inst.repositories.some((r) => r.fullName.toLowerCase() === wanted)) {
      return { covered: true, installationId: inst.id, installUrl: null };
    }
  }
  return {
    covered: false,
    installationId: null,
    installUrl: `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`,
  };
}
