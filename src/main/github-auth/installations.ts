import { GITHUB_API_BASE, isRepoAllowed, type GithubAllowPolicy } from "./config";
import { callGithub } from "./device-flow";
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
  /** Installed AND permitted by the allowlist: the only state in which an agent may use the repo. */
  covered: boolean;
  /** Why not covered: the App is not installed there, or the allowlist excludes it. */
  reason: "covered" | "not_installed" | "not_allowed";
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
  const res = await callGithub(http, { method: "GET", url: `${GITHUB_API_BASE}${path}`, headers: apiHeaders(token) });
  if (res.status === 401) throw new GithubUnauthorizedError("GitHub rejected the access token");
  if (res.status !== 200) throw new Error(`GitHub API ${path} failed: HTTP ${res.status}`);
  return asRecord(res.json);
}

export async function fetchViewerLogin(http: GithubHttp, token: string): Promise<string | null> {
  const body = await getJson(http, token, "/user");
  return typeof body.login === "string" ? body.login : null;
}

const PAGE_SIZE = 100;
/** Safety stop: 100 pages x 100 items is far beyond any real installation. */
const MAX_PAGES = 100;

/** Every item of a paginated list endpoint. Page 1 keeps the bare `?per_page=` URL. */
async function listAll(http: GithubHttp, token: string, path: string, key: string): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await getJson(http, token, `${path}?per_page=${PAGE_SIZE}${page > 1 ? `&page=${page}` : ""}`);
    const batch = Array.isArray(body[key]) ? (body[key] as unknown[]) : [];
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return items;
}

export async function listInstallations(http: GithubHttp, token: string): Promise<GithubInstallation[]> {
  const raw = await listAll(http, token, "/user/installations", "installations");
  const result: GithubInstallation[] = [];
  for (const item of raw) {
    const inst = asRecord(item);
    if (typeof inst.id !== "number") continue;
    const repoItems = await listAll(http, token, `/user/installations/${inst.id}/repositories`, "repositories");
    const login = asRecord(inst.account).login;
    result.push({
      id: inst.id,
      account: typeof login === "string" ? login : "unknown",
      repositories: repoItems.flatMap((r) => {
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
  allow: GithubAllowPolicy[] = [],
): RepoCoverage {
  if (!isRepoAllowed(allow, repoFullName)) {
    return { covered: false, reason: "not_allowed", installationId: null, installUrl: null };
  }
  const wanted = repoFullName.toLowerCase();
  for (const inst of installations) {
    if (inst.repositories.some((r) => r.fullName.toLowerCase() === wanted)) {
      return { covered: true, reason: "covered", installationId: inst.id, installUrl: null };
    }
  }
  return {
    covered: false,
    reason: "not_installed",
    installationId: null,
    installUrl: `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`,
  };
}
