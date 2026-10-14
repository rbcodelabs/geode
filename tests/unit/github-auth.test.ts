import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkRepoCoverage,
  GithubAuthError,
  GithubAuthService,
  GithubTokenStore,
  resolveGithubClientId,
  resolveGithubAppSettings,
  parseGithubAppConfig,
  assessPermissions,
  isRepoAllowed,
  type GithubAppSettings,
  DEFAULT_GITHUB_CLIENT_ID,
  type GithubHttp,
  type GithubHttpRequest,
} from "../../src/main/github-auth";
import { SecretStore, type SecretCrypto } from "../../src/main/secret-store";

type Handler = (req: GithubHttpRequest) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;

/** A fake GitHub: routes by URL (+ grant_type for the token endpoint) and records every request. */
function fakeGithub(routes: Record<string, Handler | Handler[]>) {
  const calls: GithubHttpRequest[] = [];
  const http: GithubHttp = async (req) => {
    calls.push(req);
    const key = req.form?.grant_type ? `${req.url}#${req.form.grant_type}` : req.url;
    const route = routes[key] ?? routes[req.url];
    if (!route) throw new Error(`unexpected request ${req.method} ${key}`);
    const handler = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]) : route;
    const res = await handler(req);
    return { status: res.status ?? 200, json: res.json };
  };
  return { http, calls };
}

const DEVICE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT = `${TOKEN_URL}#urn:ietf:params:oauth:grant-type:device_code`;
const REFRESH_GRANT = `${TOKEN_URL}#refresh_token`;

const deviceResponse = {
  device_code: "dev123",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};
const tokenResponse = (n: number) => ({
  access_token: `ghu_access${n}`,
  refresh_token: `ghr_refresh${n}`,
  expires_in: 28800,
  refresh_token_expires_in: 15811200,
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeCrypto(): SecretCrypto {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (buf) => buf.toString("utf8").replace(/^enc:/, ""),
  };
}

const APP_URL = "https://api.github.com/apps/geode-app";
const goodApp = {
  slug: "geode-app",
  name: "Geode App",
  client_id: "client-x",
  owner: { login: "acme", type: "Organization" },
  permissions: { contents: "write", pull_requests: "write", metadata: "read", actions: "read", checks: "read" },
};

function setup(
  routes: Record<string, Handler | Handler[]>,
  opts: { crypto?: SecretCrypto; settings?: Partial<GithubAppSettings> } = {},
) {
  routes = { [APP_URL]: () => ({ json: goodApp }), ...routes };
  const settings: GithubAppSettings = { clientId: "client-x", appSlug: "geode-app", allow: [], ...opts.settings };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-gh-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "github-auth.json");
  const secrets = new SecretStore(file, opts.crypto ?? fakeCrypto());
  const store = new GithubTokenStore(secrets);
  const fake = fakeGithub(routes);
  const clock = { t: 1_000_000 };
  const sleeps: number[] = [];
  const service = new GithubAuthService({
    http: fake.http,
    store,
    settings: () => settings,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
  });
  return { service, store, file, secrets, clock, sleeps, settings, ...fake };
}

const userRoute: Record<string, Handler> = { "https://api.github.com/user": () => ({ json: { login: "octocat" } }) };

describe("device flow", () => {
  it("goes pending -> success and stores tokens", async () => {
    const h = setup({
      [DEVICE_URL]: () => ({ json: deviceResponse }),
      [DEVICE_GRANT]: [() => ({ json: { error: "authorization_pending" } }), () => ({ json: tokenResponse(1) })],
      ...userRoute,
    });
    const device = await h.service.startSignIn();
    expect(device.userCode).toBe("ABCD-1234");
    expect(h.service.getStatus()).toMatchObject({ state: "pending", userCode: "ABCD-1234" });
    await h.service.waitForSignIn();
    expect(h.service.getStatus()).toEqual({
      state: "connected",
      login: "octocat",
      app: { slug: "geode-app", clientId: "client-x" },
    });
    expect(h.sleeps).toEqual([5000, 5000]);
    expect(await h.service.getAccessToken()).toBe("ghu_access1");
    expect(h.calls.find((c) => c.url === DEVICE_URL)?.form).toEqual({ client_id: "client-x" });
  });

  it("bumps the interval on slow_down", async () => {
    const h = setup({
      [DEVICE_URL]: () => ({ json: deviceResponse }),
      [DEVICE_GRANT]: [
        () => ({ json: { error: "slow_down", interval: 10 } }),
        () => ({ json: { error: "slow_down" } }),
        () => ({ json: tokenResponse(1) }),
      ],
      ...userRoute,
    });
    await h.service.startSignIn();
    await h.service.waitForSignIn();
    // 5s, then GitHub's 10s, then +5s when no interval is supplied.
    expect(h.sleeps).toEqual([5000, 10000, 15000]);
  });

  it("reports expired_token", async () => {
    const h = setup({
      [DEVICE_URL]: () => ({ json: deviceResponse }),
      [DEVICE_GRANT]: () => ({ json: { error: "expired_token" } }),
    });
    await h.service.startSignIn();
    await h.service.waitForSignIn();
    expect(h.service.getStatus()).toMatchObject({ state: "error", message: expect.stringContaining("expired") });
    expect(h.store.load()).toBeNull();
  });

  it("gives up when the local deadline passes", async () => {
    const h = setup({
      [DEVICE_URL]: () => ({ json: { ...deviceResponse, expires_in: 10 } }),
      [DEVICE_GRANT]: () => ({ json: { error: "authorization_pending" } }),
    });
    await h.service.startSignIn();
    await h.service.waitForSignIn();
    expect(h.service.getStatus()).toMatchObject({ state: "error" });
  });

  it("reports access_denied and stores nothing", async () => {
    const h = setup({
      [DEVICE_URL]: () => ({ json: deviceResponse }),
      [DEVICE_GRANT]: () => ({ json: { error: "access_denied" } }),
    });
    await h.service.startSignIn();
    await h.service.waitForSignIn();
    expect(h.service.getStatus()).toMatchObject({ state: "error", message: expect.stringContaining("denied") });
    expect(h.store.load()).toBeNull();
  });

  it("refuses to start without a keychain", async () => {
    const h = setup({}, { crypto: { ...fakeCrypto(), isEncryptionAvailable: () => false } });
    await expect(h.service.startSignIn()).rejects.toBeInstanceOf(GithubAuthError);
    expect(h.service.getStatus()).toMatchObject({ state: "disconnected", encryptionAvailable: false });
  });
});

describe("refresh", () => {
  async function connected(routes: Record<string, Handler | Handler[]>) {
    const h = setup({
      [DEVICE_URL]: () => ({ json: deviceResponse }),
      [DEVICE_GRANT]: () => ({ json: tokenResponse(1) }),
      ...userRoute,
      ...routes,
    });
    await h.service.startSignIn();
    await h.service.waitForSignIn();
    return h;
  }

  it("does not refresh a fresh token", async () => {
    const h = await connected({});
    await h.service.getAccessToken();
    expect(h.calls.some((c) => c.form?.grant_type === "refresh_token")).toBe(false);
  });

  it("rotates the refresh token and persists the new pair", async () => {
    const h = await connected({ [REFRESH_GRANT]: () => ({ json: tokenResponse(2) }) });
    h.clock.t += 8 * 3600 * 1000; // past expiry
    expect(await h.service.getAccessToken()).toBe("ghu_access2");
    const refreshCall = h.calls.find((c) => c.form?.grant_type === "refresh_token")!;
    expect(refreshCall.form?.refresh_token).toBe("ghr_refresh1");
    expect(h.store.load()).toMatchObject({ accessToken: "ghu_access2", refreshToken: "ghr_refresh2", login: "octocat" });
    // Survives a restart: a fresh store over the same file sees the rotated token.
    const reopened = new GithubTokenStore(new SecretStore(h.file, fakeCrypto()));
    expect(reopened.load()?.refreshToken).toBe("ghr_refresh2");
  });

  it("single-flights concurrent refreshes", async () => {
    let refreshes = 0;
    const h = await connected({ [REFRESH_GRANT]: () => (refreshes++, { json: tokenResponse(2) }) });
    h.clock.t += 8 * 3600 * 1000;
    const tokens = await Promise.all([h.service.getAccessToken(), h.service.getAccessToken()]);
    expect(tokens).toEqual(["ghu_access2", "ghu_access2"]);
    expect(refreshes).toBe(1);
  });

  it("requires reauth and clears tokens when the refresh token is rejected", async () => {
    const h = await connected({ [REFRESH_GRANT]: () => ({ json: { error: "bad_refresh_token" } }) });
    h.clock.t += 8 * 3600 * 1000;
    await expect(h.service.getAccessToken()).rejects.toMatchObject({ code: "reauth_required" });
    expect(h.store.load()).toBeNull();
    expect(h.service.getStatus()).toMatchObject({ state: "reauth_required" });
  });

  it("keeps credentials on a transient network failure", async () => {
    const h = await connected({ [REFRESH_GRANT]: () => ({ status: 502, json: null }) });
    h.clock.t += 8 * 3600 * 1000;
    await expect(h.service.getAccessToken()).rejects.toMatchObject({ code: "network" });
    expect(h.store.load()?.refreshToken).toBe("ghr_refresh1");
  });

  it("refreshes once and retries when GitHub rejects a still-unexpired token", async () => {
    let userCalls = 0;
    const h = await connected({
      "https://api.github.com/user/installations?per_page=100": (req) =>
        req.headers?.Authorization === "Bearer ghu_access2"
          ? { json: { installations: [] } }
          : (userCalls++, { status: 401, json: { message: "Bad credentials" } }),
      [REFRESH_GRANT]: () => ({ json: tokenResponse(2) }),
    });
    expect(await h.service.listAccess()).toEqual([]);
    expect(userCalls).toBe(1);
  });
});

describe("keychain storage", () => {
  it("round-trips and never writes plaintext tokens to disk", async () => {
    const h = setup({});
    await h.store.save({
      accessToken: "ghu_secret_access",
      refreshToken: "ghr_secret_refresh",
      accessTokenExpiresAt: 5,
      refreshTokenExpiresAt: 6,
      login: "octocat",
    });
    const onDisk = fs.readFileSync(h.file, "utf8");
    expect(onDisk).not.toContain("ghu_secret_access");
    expect(onDisk).not.toContain("ghr_secret_refresh");
    const reopened = new GithubTokenStore(new SecretStore(h.file, fakeCrypto()));
    expect(reopened.load()).toMatchObject({ accessToken: "ghu_secret_access", refreshToken: "ghr_secret_refresh", login: "octocat" });
  });

  it("disconnect deletes local tokens and points at GitHub for revocation without calling the API", async () => {
    const h = setup({
      [DEVICE_URL]: () => ({ json: deviceResponse }),
      [DEVICE_GRANT]: () => ({ json: tokenResponse(1) }),
      ...userRoute,
    });
    await h.service.startSignIn();
    await h.service.waitForSignIn();
    const before = h.calls.length;
    const { revokeUrl } = await h.service.disconnect();
    expect(revokeUrl).toBe("https://github.com/settings/applications");
    expect(h.calls.length).toBe(before);
    expect(h.store.load()).toBeNull();
    expect(fs.readFileSync(h.file, "utf8")).not.toContain("ghu_access1");
    expect(h.service.getStatus()).toMatchObject({ state: "disconnected" });
  });
});

describe("installation coverage", () => {
  const routes = {
    [DEVICE_URL]: () => ({ json: deviceResponse }),
    [DEVICE_GRANT]: () => ({ json: tokenResponse(1) }),
    ...userRoute,
    "https://api.github.com/user/installations?per_page=100": () => ({
      json: { installations: [{ id: 42, account: { login: "acme" } }] },
    }),
    "https://api.github.com/user/installations/42/repositories?per_page=100": () => ({
      json: { repositories: [{ id: 1, full_name: "acme/widgets", private: true }] },
    }),
  };

  it("lists installations with their repositories", async () => {
    const h = setup(routes);
    await h.service.startSignIn();
    await h.service.waitForSignIn();
    expect(await h.service.listAccess()).toEqual([
      { id: 42, account: "acme", repositories: [{ id: 1, fullName: "acme/widgets", private: true }] },
    ]);
  });

  it("reports covered and uncovered repos with an install URL", async () => {
    const h = setup(routes);
    await h.service.startSignIn();
    await h.service.waitForSignIn();
    expect(await h.service.checkRepo("ACME/Widgets")).toEqual({
      covered: true,
      reason: "covered",
      installationId: 42,
      installUrl: null,
    });
    expect(await h.service.checkRepo("acme/other")).toEqual({
      covered: false,
      reason: "not_installed",
      installationId: null,
      installUrl: "https://github.com/apps/geode-app/installations/new",
    });
  });

  it("treats no installations as uncovered", () => {
    expect(checkRepoCoverage([], "a/b", "geode").covered).toBe(false);
  });
});

describe("client id", () => {
  it("defaults and honors the env override", () => {
    expect(resolveGithubClientId({})).toBe(DEFAULT_GITHUB_CLIENT_ID);
    expect(resolveGithubClientId({ GEODE_GITHUB_CLIENT_ID: " Iv-test " })).toBe("Iv-test");
  });
});

describe("app settings layers", () => {
  it("reads geode.json, lets the vault override it, and env beats both", () => {
    const global = { clientId: "Iv-global", appSlug: "global-app" };
    expect(resolveGithubAppSettings({ env: {}, global })).toMatchObject({ clientId: "Iv-global", appSlug: "global-app" });
    expect(resolveGithubAppSettings({ env: {}, global, vault: { appSlug: "vault-app" } })).toMatchObject({
      clientId: "Iv-global",
      appSlug: "vault-app",
    });
    expect(
      resolveGithubAppSettings({ env: { GEODE_GITHUB_APP_SLUG: "env-app" }, global, vault: { appSlug: "vault-app" } }).appSlug,
    ).toBe("env-app");
    expect(resolveGithubAppSettings({ env: {} })).toMatchObject({ clientId: DEFAULT_GITHUB_CLIENT_ID, allow: [] });
  });

  it("drops malformed values instead of trusting them", () => {
    expect(parseGithubAppConfig({ clientId: 5, appSlug: "bad slug!", allowedOwners: "acme" })).toEqual({});
    expect(parseGithubAppConfig("nope")).toEqual({});
  });

  it("fails closed when an allowlist has only invalid entries", () => {
    const s = resolveGithubAppSettings({ env: {}, global: { allowedOwners: ["../evil", 3] } });
    expect(isRepoAllowed(s.allow, "acme/widgets")).toBe(false);
  });

  it("lets a vault narrow but never widen the global allowlist", () => {
    const global = { allowedOwners: ["acme"] };
    const wide = resolveGithubAppSettings({ env: {}, global, vault: { allowedOwners: ["evil"] } });
    expect(isRepoAllowed(wide.allow, "evil/x")).toBe(false);
    expect(isRepoAllowed(wide.allow, "acme/x")).toBe(false);
    const narrow = resolveGithubAppSettings({ env: {}, global, vault: { allowedRepos: ["acme/only"] } });
    expect(isRepoAllowed(narrow.allow, "acme/only")).toBe(true);
    expect(isRepoAllowed(narrow.allow, "acme/other")).toBe(false);
  });

  it("env allowlist replaces geode.json and matches case-insensitively", () => {
    const s = resolveGithubAppSettings({ env: { GEODE_GITHUB_ALLOWED_OWNERS: "Bankrate-Prototypes" }, global: { allowedOwners: ["acme"] } });
    expect(isRepoAllowed(s.allow, "bankrate-prototypes/app")).toBe(true);
    expect(isRepoAllowed(s.allow, "acme/app")).toBe(false);
  });
});

describe("permission assessment", () => {
  it("is clean for exactly the required set", () => {
    expect(assessPermissions(goodApp.permissions)).toEqual({ missing: [], extra: [] });
  });

  it("flags missing pull_requests and extra powers", () => {
    const r = assessPermissions({ contents: "write", metadata: "read", actions: "read", checks: "read", administration: "write", members: "read" });
    expect(r.missing).toEqual([{ permission: "pull_requests", needed: "write", have: null }]);
    expect(r.extra.map((e) => e.permission).sort()).toEqual(["administration", "members"]);
  });

  it("treats too-weak and too-strong levels", () => {
    const r = assessPermissions({ ...goodApp.permissions, contents: "read", actions: "write" });
    expect(r.missing).toEqual([{ permission: "contents", needed: "write", have: "read" }]);
    expect(r.extra).toEqual([{ permission: "actions", level: "write", needed: "read" }]);
  });
});

describe("App verification at sign-in", () => {
  const ok = { [DEVICE_URL]: () => ({ json: deviceResponse }), [DEVICE_GRANT]: () => ({ json: tokenResponse(1) }), ...userRoute };

  it("refuses an unknown App slug and never asks for a device code", async () => {
    const h = setup({ ...ok, [APP_URL]: () => ({ status: 404, json: { message: "Not Found" } }) });
    await expect(h.service.startSignIn()).rejects.toMatchObject({ code: "app_not_found" });
    expect(h.calls.some((c) => c.url === DEVICE_URL)).toBe(false);
  });

  it("refuses a client ID that belongs to a different App", async () => {
    const h = setup({ ...ok, [APP_URL]: () => ({ json: { ...goodApp, client_id: "other" } }) });
    await expect(h.service.startSignIn()).rejects.toMatchObject({ code: "app_mismatch" });
  });

  it("explains device_flow_disabled and links the (org) App settings", async () => {
    const h = setup({ ...ok, [DEVICE_URL]: () => ({ json: { error: "device_flow_disabled", error_description: "Device flow must be explicitly enabled" } }) });
    const err = await h.service.startSignIn().catch((e) => e);
    expect(err).toBeInstanceOf(GithubAuthError);
    expect(err).toMatchObject({ code: "device_flow_disabled", url: "https://github.com/organizations/acme/settings/apps/geode-app" });
    expect(err.message).toMatch(/Device Flow is turned off/);
  });

  it("still tries to connect when GitHub cannot confirm the App", async () => {
    const h = setup({ ...ok, [APP_URL]: () => ({ status: 503, json: null }) });
    await h.service.startSignIn();
    await h.service.waitForSignIn();
    expect(h.service.getStatus()).toMatchObject({ state: "connected" });
  });

  it("requires confirmation for extra permissions, then connects", async () => {
    const wide = { ...goodApp, permissions: { ...goodApp.permissions, administration: "write" } };
    const h = setup({ ...ok, [APP_URL]: () => ({ json: wide }) });
    await expect(h.service.startSignIn()).rejects.toMatchObject({ code: "confirmation_required" });
    await h.service.startSignIn({ confirmExtraPermissions: true });
    await h.service.waitForSignIn();
    expect(h.service.getStatus()).toMatchObject({ state: "connected" });
  });

  it("warns (does not block) about missing permissions and names the App", async () => {
    const weak = { ...goodApp, permissions: { contents: "write", metadata: "read" } };
    const h = setup({ ...ok, [APP_URL]: () => ({ json: weak }) });
    const report = await h.service.getAppReport();
    expect(report).toMatchObject({ name: "Geode App", slug: "geode-app", problem: null });
    expect(report.permissions?.missing.map((m) => m.permission)).toEqual(["pull_requests", "actions", "checks"]);
    await h.service.startSignIn();
  });
});

describe("App change", () => {
  const ok = { [DEVICE_URL]: () => ({ json: deviceResponse }), [DEVICE_GRANT]: () => ({ json: tokenResponse(1) }), ...userRoute };

  it("drops the token and asks to reconnect when the client ID changes", async () => {
    const h = setup(ok);
    await h.service.startSignIn();
    await h.service.waitForSignIn();
    expect(h.store.load()?.clientId).toBe("client-x");
    h.settings.clientId = "client-y";
    expect(h.service.getStatus()).toMatchObject({ state: "reauth_required", app: { clientId: "client-y" } });
    await expect(h.service.getAccessToken()).rejects.toMatchObject({ code: "reauth_required" });
    expect(h.store.load()).toBeNull();
  });

  it("treats a legacy token with no recorded App as the default App", async () => {
    const h = setup({}, { settings: { clientId: DEFAULT_GITHUB_CLIENT_ID } });
    await h.store.save({ accessToken: "ghu_old", refreshToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, login: "o", clientId: null });
    expect(await h.service.getAccessToken()).toBe("ghu_old");
    const other = setup({}, { settings: { clientId: "client-x" } });
    await other.store.save({ accessToken: "ghu_old", refreshToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, login: "o", clientId: null });
    await expect(other.service.getAccessToken()).rejects.toMatchObject({ code: "reauth_required" });
  });
});

describe("allowlist", () => {
  const routes: Record<string, Handler> = {
    [DEVICE_URL]: () => ({ json: deviceResponse }),
    [DEVICE_GRANT]: () => ({ json: tokenResponse(1) }),
    ...userRoute,
    "https://api.github.com/user/installations?per_page=100": () => ({ json: { installations: [{ id: 42, account: { login: "acme" } }] } }),
    "https://api.github.com/user/installations/42/repositories?per_page=100": () => ({
      json: { repositories: [{ id: 1, full_name: "acme/widgets", private: true }, { id: 2, full_name: "acme/secret", private: true }] },
    }),
  };

  it("filters listAccess, blocks checkRepo, and refuses tokens for repos outside it", async () => {
    const h = setup(routes, { settings: { allow: [{ owners: [], repos: ["acme/widgets"] }] } });
    await h.service.startSignIn();
    await h.service.waitForSignIn();
    expect((await h.service.listAccess())[0].repositories.map((r) => r.fullName)).toEqual(["acme/widgets"]);
    expect(await h.service.checkRepo("acme/secret")).toMatchObject({ covered: false, reason: "not_allowed", installUrl: null });
    expect(await h.service.checkRepo("acme/widgets")).toMatchObject({ covered: true });
    await expect(h.service.getAccessToken("acme/secret")).rejects.toMatchObject({ code: "not_allowed" });
    expect(await h.service.getAccessToken("acme/widgets")).toBe("ghu_access1");
  });
});

describe("settings panel warnings", () => {
  it("says PRs will fail and that agents hold extra powers", async () => {
    const { permissionWarnings } = await import("../../src/renderer/settings/github-tab");
    const report = {
      permissions: assessPermissions({ contents: "write", metadata: "read", actions: "read", checks: "read", administration: "write" }),
    } as Parameters<typeof permissionWarnings>[0];
    const lines = permissionWarnings(report);
    expect(lines[0]).toMatch(/Opening pull requests will fail/);
    expect(lines[1]).toMatch(/administration \(write\).*Agent threads will hold/);
    expect(permissionWarnings(null)).toEqual([]);
  });
});
