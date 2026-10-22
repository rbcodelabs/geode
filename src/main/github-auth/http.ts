/**
 * The only network seam of the GitHub auth module. Everything takes a
 * `GithubHttp`, so tests substitute a fake GitHub server and nothing here ever
 * touches the real network under vitest.
 */
export interface GithubHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  /** Sent form-encoded when present. */
  form?: Record<string, string>;
}

export interface GithubHttpResponse {
  status: number;
  /** Parsed JSON body, or null when the body was empty / not JSON. */
  json: unknown;
}

export type GithubHttp = (request: GithubHttpRequest) => Promise<GithubHttpResponse>;

/**
 * Test seam: `GEODE_GITHUB_API_BASE` redirects api.github.com and
 * `GEODE_GITHUB_WEB_BASE` redirects github.com (device flow endpoints) to a
 * local fake, like the existing community-install override. Unset in
 * production. Anyone who can set the app's environment can already do far more
 * than redirect these calls, so this is not a policy boundary.
 */
export function rewriteGithubUrl(url: string, env: Record<string, string | undefined> = process.env): string {
  const api = env.GEODE_GITHUB_API_BASE?.replace(/\/+$/, "");
  const web = env.GEODE_GITHUB_WEB_BASE?.replace(/\/+$/, "");
  if (api && url.startsWith("https://api.github.com/")) return api + url.slice("https://api.github.com".length);
  if (web && url.startsWith("https://github.com/")) return web + url.slice("https://github.com".length);
  return url;
}

/** Production implementation over the global `fetch` (Electron main / Node 18+). */
export const fetchGithubHttp: GithubHttp = async (rawRequest) => {
  const request = { ...rawRequest, url: rewriteGithubUrl(rawRequest.url) };
  const headers: Record<string, string> = { Accept: "application/json", ...request.headers };
  let body: string | undefined;
  if (request.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(request.form).toString();
  }
  const response = await fetch(request.url, { method: request.method, headers, body });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
