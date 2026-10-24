import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeGithubAppSettings,
  DEFAULT_GITHUB_APP_SLUG,
  DEFAULT_GITHUB_CLIENT_ID,
  githubLoginAllowed,
  GithubAuthService,
  GithubTokenStore,
  isRepoAllowed,
  resolveGithubAppSettings,
  rewriteGithubUrl,
  type GithubAppSettings,
  type GithubHttp,
  type GithubHttpRequest,
} from "../../src/main/github-auth";
import { appSettingsNotes, MANAGED_NOTE } from "../../src/renderer/settings/github-tab";
import { validatePolicy } from "../../src/renderer/policy";
import { resolveEffectivePolicy } from "../../src/renderer/policy-layering";
import { SecretStore, type SecretCrypto } from "../../src/main/secret-store";

/** Real stage-1 pipeline: validate machine (+ optional vault) JSON, merge, take the github slice. */
function effectiveGithub(machine: unknown, vault?: unknown) {
  return resolveEffectivePolicy(validatePolicy({ policyVersion: 1, ...(machine as object) }), vault ? validatePolicy({ policyVersion: 1, ...(vault as object) }) : null)
    .effective.github;
}

type Handler = (req: GithubHttpRequest) => { status?: number; json: unknown };

function fakeGithub(routes: Record<string, Handler | Handler[]>) {
  const calls: GithubHttpRequest[] = [];
  const http: GithubHttp = async (req) => {
    calls.push(req);
    const key = req.form?.grant_type ? `${req.url}#${req.form.grant_type}` : req.url;
    const route = routes[key] ?? routes[req.url];
    if (!route) throw new Error(`unexpected request ${req.method} ${key}`);
    const handler = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]) : route;
    const res = handler(req);
    return { status: res.status ?? 200, json: res.json };
  };
  return { http, calls };
}

const DEVICE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEVICE_GRANT = `${TOKEN_URL}#urn:ietf:params:oauth:grant-type:device_code`;
const deviceResponse = { device_code: "dev123", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };
const tokenResponse = { access_token: "ghu_access1", refresh_token: "ghr_refresh1", expires_in: 28800, refresh_token_expires_in: 15811200 };
const goodApp = (slug: string, clientId: string) => ({
  slug,
  name: "App",
  client_id: clientId,
  owner: { login: "acme", type: "Organization" },
  permissions: { contents: "write", pull_requests: "write", metadata: "read", actions: "read", checks: "read" },
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const crypto: SecretCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
  decryptString: (buf) => buf.toString("utf8").replace(/^enc:/, ""),
};

function setup(opts: { login?: string; settings?: Partial<GithubAppSettings>; slug?: string; clientId?: string }) {
  const slug = opts.slug ?? "geode-app";
  const clientId = opts.clientId ?? "client-x";
  const routes: Record<string, Handler> = {
    [`https://api.github.com/apps/${slug}`]: () => ({ json: goodApp(slug, clientId) }),
    [DEVICE_URL]: () => ({ json: deviceResponse }),
    [DEVICE_GRANT]: () => ({ json: tokenResponse }),
    "https://api.github.com/user": () => ({ json: { login: opts.login ?? "octocat" } }),
    "https://api.github.com/user/installations?per_page=100": () => ({ json: { installations: [{ id: 42, account: { login: "acme" } }] } }),
    "https://api.github.com/user/installations/42/repositories?per_page=100": () => ({
      json: { repositories: [{ id: 1, full_name: "acme/widgets", private: true }, { id: 2, full_name: "other/thing", private: true }] },
    }),
  };
  const settings: GithubAppSettings = { clientId, appSlug: slug, allow: [], ...opts.settings };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-ghp-"));
  tmpDirs.push(dir);
  const store = new GithubTokenStore(new SecretStore(path.join(dir, "github-auth.json"), crypto));
  const fake = fakeGithub(routes);
  const service = new GithubAuthService({ http: fake.http, store, settings: () => settings, now: () => 1_000_000, sleep: async () => {} });
  return { service, store, settings, ...fake };
}

const connect = async (h: ReturnType<typeof setup>) => {
  await h.service.startSignIn();
  await h.service.waitForSignIn();
};

describe("resolveGithubAppSettings with managed policy", () => {
  const env = { GEODE_GITHUB_CLIENT_ID: "Iv-env", GEODE_GITHUB_APP_SLUG: "env-app" };
  const global = { clientId: "Iv-global", appSlug: "global-app" };
  const vault = { clientId: "Iv-vault", appSlug: "vault-app" };
  const policy = effectiveGithub({ github: { clientId: "Iv-policy", appSlug: "policy-app" } });

  it("lets a policy pin beat env, vault and geode.json, even with settingsLocked false", () => {
    expect(policy.settingsLocked).toBe(false);
    expect(resolveGithubAppSettings({ env, global, vault, policy })).toMatchObject({ clientId: "Iv-policy", appSlug: "policy-app" });
    expect(resolveGithubAppSettings({ env: {}, global, policy })).toMatchObject({ clientId: "Iv-policy", appSlug: "policy-app" });
    expect(resolveGithubAppSettings({ env: {}, policy })).toMatchObject({ clientId: "Iv-policy", appSlug: "policy-app" });
  });

  it("pins each field independently", () => {
    const onlyId = effectiveGithub({ github: { clientId: "Iv-policy" } });
    expect(resolveGithubAppSettings({ env, global, vault, policy: onlyId })).toMatchObject({ clientId: "Iv-policy", appSlug: "env-app" });
    const onlySlug = effectiveGithub({ github: { appSlug: "policy-app" } });
    expect(resolveGithubAppSettings({ env: {}, global, vault, policy: onlySlug })).toMatchObject({ clientId: "Iv-vault", appSlug: "policy-app" });
  });

  it("keeps the old precedence when nothing is pinned (baseline unchanged)", () => {
    expect(resolveGithubAppSettings({ env, global, vault })).toMatchObject({ clientId: "Iv-env", appSlug: "env-app" });
    expect(resolveGithubAppSettings({ env: {}, global, vault })).toMatchObject({ clientId: "Iv-vault", appSlug: "vault-app" });
    expect(resolveGithubAppSettings({ env: {}, global })).toMatchObject({ clientId: "Iv-global", appSlug: "global-app" });
    const none = resolveGithubAppSettings({ env: {} });
    expect(none).toMatchObject({ clientId: DEFAULT_GITHUB_CLIENT_ID, appSlug: DEFAULT_GITHUB_APP_SLUG, allow: [] });
    expect(none.policy).toBeUndefined();
    // An effective policy with no github restrictions changes nothing either.
    expect(resolveGithubAppSettings({ env: {}, global, vault, policy: effectiveGithub({}) })).toMatchObject({ clientId: "Iv-vault", allow: [] });
  });

  it("adds managed allowlists to the every-policy-must-pass intersection that no other layer removes", () => {
    const managed = effectiveGithub({ github: { allowedOwners: ["acme"] } });
    // env replaces geode.json's list, but cannot replace the managed one.
    const s = resolveGithubAppSettings({ env: { GEODE_GITHUB_ALLOWED_OWNERS: "other" }, global: { allowedOwners: ["acme"] }, policy: managed });
    expect(isRepoAllowed(s.allow, "acme/x")).toBe(false); // env says other
    expect(isRepoAllowed(s.allow, "other/x")).toBe(false); // managed says acme
    const open = resolveGithubAppSettings({ env: {}, policy: managed });
    expect(isRepoAllowed(open.allow, "acme/x")).toBe(true);
    expect(isRepoAllowed(open.allow, "other/x")).toBe(false);
    // geode.json cannot widen it.
    const widened = resolveGithubAppSettings({ env: {}, global: { allowedOwners: ["acme", "other"] }, policy: managed });
    expect(isRepoAllowed(widened.allow, "other/x")).toBe(false);
    // A vault narrows further.
    const narrowed = resolveGithubAppSettings({ env: {}, vault: { allowedRepos: ["acme/widgets"] }, policy: managed });
    expect(isRepoAllowed(narrowed.allow, "acme/widgets")).toBe(true);
    expect(isRepoAllowed(narrowed.allow, "acme/other")).toBe(false);
  });

  it("applies the vault policy layer's narrowing on top of the machine layer", () => {
    const eff = effectiveGithub({ github: { allowedOwners: ["acme", "beta"] } }, { github: { allowedOwners: ["beta"] } });
    const s = resolveGithubAppSettings({ env: {}, policy: eff });
    expect(isRepoAllowed(s.allow, "beta/x")).toBe(true);
    expect(isRepoAllowed(s.allow, "acme/x")).toBe(false);
  });

  it("fails closed on an unusable managed list", () => {
    const bad = effectiveGithub({ github: { allowedOwners: ["not valid!"] } });
    const s = resolveGithubAppSettings({ env: {}, policy: bad });
    expect(isRepoAllowed(s.allow, "acme/x")).toBe(false);
    const badType = effectiveGithub({ github: { allowedRepos: "acme/x" } });
    expect(isRepoAllowed(resolveGithubAppSettings({ env: {}, policy: badType }).allow, "acme/x")).toBe(false);
  });

  it("carries the policy controls", () => {
    const eff = effectiveGithub({ github: { settingsLocked: true, connect: false, disconnect: false, clientId: "Iv-policy", allowedLogins: ["octocat"] } });
    expect(resolveGithubAppSettings({ env: {}, policy: eff }).policy).toEqual({
      settingsLocked: true,
      connect: false,
      disconnect: false,
      loginRestricted: true,
      allowedLogins: [["octocat"]],
      clientIdPinned: true,
    });
  });
});

describe("describeGithubAppSettings with managed policy", () => {
  it("reports the policy as the source and as what overrides geode.json", () => {
    const policy = effectiveGithub({ github: { clientId: "Iv-policy", settingsLocked: true, allowedOwners: ["acme"] } });
    const view = describeGithubAppSettings({ env: { GEODE_GITHUB_CLIENT_ID: "Iv-env" }, global: { clientId: "Iv-g", appSlug: "g" }, vault: { clientId: "Iv-v" }, policy });
    expect(view.clientId).toEqual({ value: "Iv-policy", source: "policy" });
    expect(view.appSlug).toEqual({ value: "g", source: "global" });
    expect(view.overriddenBy).toEqual({ clientId: "policy", appSlug: null });
    expect(view.allowSources.policy).toBe(true);
    expect(view.managed).toMatchObject({ settingsLocked: true, connect: true });
  });

  it("agrees with the resolver for every combination of layers", () => {
    const layersets = [
      { policy: effectiveGithub({ github: { clientId: "Iv-p", appSlug: "p-app" } }), env: { GEODE_GITHUB_CLIENT_ID: "e", GEODE_GITHUB_APP_SLUG: "e-app" } },
      { policy: effectiveGithub({ github: { appSlug: "p-app" } }), global: { clientId: "Iv-g" }, vault: { clientId: "Iv-v" } },
      { policy: effectiveGithub({}), global: { clientId: "Iv-g", appSlug: "g-app" } },
    ];
    for (const layers of layersets) {
      const resolved = resolveGithubAppSettings({ env: {}, ...layers });
      const view = describeGithubAppSettings({ env: {}, ...layers });
      expect(view.clientId.value).toBe(resolved.clientId);
      expect(view.appSlug.value).toBe(resolved.appSlug);
    }
  });

  it("explains pins and locks as managed by the administrator", () => {
    const policy = effectiveGithub({ github: { appSlug: "corp-geode", settingsLocked: true, allowedOwners: ["acme"], connect: false, disconnect: false } });
    const notes = appSettingsNotes(describeGithubAppSettings({ env: {}, global: { appSlug: "mine" }, policy }));
    expect(notes[0]).toContain("corp-geode (administrator policy)");
    const text = notes.join("\n");
    expect(text).toContain("App slug is pinned by your administrator");
    expect(text).toContain("Your administrator also restricts the repositories");
    expect(text).toContain(`These settings are locked. ${MANAGED_NOTE}`);
  });

  it("says nothing about administrators when unmanaged", () => {
    const notes = appSettingsNotes(describeGithubAppSettings({ env: {}, global: { appSlug: "mine" } }));
    expect(notes.join("\n")).not.toMatch(/administrator/);
  });
});

describe("githubLoginAllowed", () => {
  it("matches exactly and case-insensitively", () => {
    expect(githubLoginAllowed([["octocat"]], "OctoCat")).toBe(true);
    expect(githubLoginAllowed([["octocat"]], "octocat2")).toBe(false);
  });
  it("supports a single leading * suffix pattern", () => {
    const emu = [["*_corp-emu", "admin"]];
    expect(githubLoginAllowed(emu, "alice_corp-emu")).toBe(true);
    expect(githubLoginAllowed(emu, "admin")).toBe(true);
    expect(githubLoginAllowed(emu, "alice_other")).toBe(false);
    expect(githubLoginAllowed(emu, "corp-emu-alice")).toBe(false);
    // A bare "*" is not a wildcard-everything.
    expect(githubLoginAllowed([["*"]], "anyone")).toBe(false);
  });
  it("requires a match in every layer's list", () => {
    expect(githubLoginAllowed([["*_emu"], ["alice_emu"]], "alice_emu")).toBe(true);
    expect(githubLoginAllowed([["*_emu"], ["alice_emu"]], "bob_emu")).toBe(false);
  });
  it("is unrestricted with no lists, and fails closed on an unknown login or the fail-closed sentinel", () => {
    expect(githubLoginAllowed([], "anyone")).toBe(true);
    expect(githubLoginAllowed([], null)).toBe(true);
    expect(githubLoginAllowed([["octocat"]], null)).toBe(false);
    const bad = effectiveGithub({ github: { allowedLogins: ["not a login!"] } });
    expect(githubLoginAllowed(bad.allowedLogins, "octocat")).toBe(false);
  });
});

describe("service enforcement", () => {
  const settingsFor = (github: object, extra: Partial<GithubAppSettings> = {}) =>
    resolveGithubAppSettings({ env: {}, global: { clientId: "client-x", appSlug: "geode-app" }, policy: effectiveGithub({ github }), ...extra });

  it("connect:false refuses sign-in with a message naming the policy and talks to nobody", async () => {
    const h = setup({ settings: settingsFor({ connect: false }) });
    await expect(h.service.startSignIn()).rejects.toMatchObject({ code: "blocked_by_policy", message: expect.stringContaining("blocked by administrator policy: github") });
    expect(h.calls).toEqual([]);
    expect(h.service.getStatus().managed.connect).toBe(false);
  });

  it("disconnect:false refuses to remove the connection and leaves the tokens", async () => {
    const h = setup({});
    await connect(h);
    Object.assign(h.settings, settingsFor({ disconnect: false }));
    await expect(h.service.disconnect()).rejects.toMatchObject({ code: "blocked_by_policy", message: expect.stringContaining("blocked by administrator policy: github") });
    expect(h.store.load()?.accessToken).toBe("ghu_access1");
    expect(h.service.getStatus().state).toBe("connected");
    Object.assign(h.settings, settingsFor({ disconnect: true }));
    await h.service.disconnect();
    expect(h.store.load()).toBeNull();
  });

  it("uses the pinned client id and app slug for the App lookup and the device flow", async () => {
    const h = setup({ slug: "corp-geode", clientId: "Iv-corp", settings: resolveGithubAppSettings({ env: { GEODE_GITHUB_CLIENT_ID: "Iv-env", GEODE_GITHUB_APP_SLUG: "env-app" }, global: { clientId: "Iv-g" }, policy: effectiveGithub({ github: { clientId: "Iv-corp", appSlug: "corp-geode" } }) }) });
    await connect(h);
    expect(h.calls.find((c) => c.url === DEVICE_URL)?.form).toEqual({ client_id: "Iv-corp" });
    expect(h.calls.some((c) => c.url === "https://api.github.com/apps/corp-geode")).toBe(true);
    expect(h.calls.some((c) => c.url.includes("env-app"))).toBe(false);
    expect(h.service.getStatus()).toMatchObject({ state: "connected", app: { slug: "corp-geode", clientId: "Iv-corp" } });
  });

  it("keeps tokens from another App when a policy pin appears, and restores them when it goes", async () => {
    const h = setup({});
    await connect(h);
    Object.assign(h.settings, settingsFor({ clientId: "Iv-corp" }));
    expect(h.service.getStatus().state).toBe("reauth_required");
    await expect(h.service.getAccessToken()).rejects.toMatchObject({ code: "reauth_required" });
    expect(h.store.load()?.accessToken).toBe("ghu_access1");
    Object.assign(h.settings, settingsFor({}));
    expect(h.service.getStatus().state).toBe("connected");
    expect(await h.service.getAccessToken()).toBe("ghu_access1");
  });

  it("an unpinned App change still drops the token (existing behavior)", async () => {
    const h = setup({});
    await connect(h);
    h.settings.clientId = "client-y";
    expect(h.service.getStatus().state).toBe("reauth_required");
    expect(h.store.load()).toBeNull();
  });

  it("rejects a sign-in whose account is not allowed and persists nothing", async () => {
    const h = setup({ login: "mallory", settings: settingsFor({ allowedLogins: ["*_corp-emu"] }) });
    await connect(h);
    expect(h.store.load()).toBeNull();
    const status = h.service.getStatus();
    expect(status.state).toBe("error");
    expect(status).toMatchObject({ message: expect.stringContaining("blocked by administrator policy: github") });
    expect(status).toMatchObject({ message: expect.stringContaining("mallory") });
    await expect(h.service.getAccessToken()).rejects.toMatchObject({ code: "reauth_required" });
  });

  it("accepts an allowed account by suffix pattern", async () => {
    const h = setup({ login: "alice_corp-emu", settings: settingsFor({ allowedLogins: ["*_corp-emu"] }) });
    await connect(h);
    expect(h.service.getStatus()).toMatchObject({ state: "connected", login: "alice_corp-emu" });
    expect(await h.service.getAccessToken()).toBe("ghu_access1");
  });

  it("fails closed when the login cannot be fetched and accounts are restricted", async () => {
    const h = setup({ settings: settingsFor({ allowedLogins: ["octocat"] }) });
    // Make /user fail.
    const original = h.http;
    const failing: GithubHttp = async (req) => (req.url === "https://api.github.com/user" ? { status: 500, json: null } : original(req));
    const service = new GithubAuthService({ http: failing, store: h.store, settings: () => h.settings, now: () => 1_000_000, sleep: async () => {} });
    await service.startSignIn();
    await service.waitForSignIn();
    expect(h.store.load()).toBeNull();
    expect(service.getStatus().state).toBe("error");
  });

  it("marks an already-connected non-matching account blocked, stops issuing tokens, and restores on relax", async () => {
    const h = setup({ login: "mallory" });
    await connect(h);
    expect(h.service.getStatus().state).toBe("connected");

    Object.assign(h.settings, settingsFor({ allowedLogins: ["*_corp-emu"] }));
    const status = h.service.getStatus();
    expect(status).toMatchObject({ state: "blocked_by_policy", login: "mallory" });
    expect((status as { message: string }).message).toMatch(/blocked by administrator policy: github.*contact your administrator/);
    await expect(h.service.getAccessToken()).rejects.toMatchObject({ code: "blocked_by_policy" });
    await expect(h.service.getAccessToken("acme/widgets")).rejects.toMatchObject({ code: "blocked_by_policy" });
    await expect(h.service.listAccess()).rejects.toMatchObject({ code: "blocked_by_policy" });
    await expect(h.service.checkRepo("acme/widgets")).rejects.toMatchObject({ code: "blocked_by_policy" });
    expect(h.store.load()?.accessToken).toBe("ghu_access1"); // non-destructive

    Object.assign(h.settings, settingsFor({}));
    expect(h.service.getStatus()).toMatchObject({ state: "connected", login: "mallory" });
    expect(await h.service.getAccessToken()).toBe("ghu_access1");
  });

  it("connect:false also stops tokens for an existing connection, and relaxing restores them", async () => {
    const h = setup({});
    await connect(h);
    Object.assign(h.settings, settingsFor({ connect: false }));
    expect(h.service.getStatus().state).toBe("blocked_by_policy");
    await expect(h.service.getAccessToken()).rejects.toMatchObject({ code: "blocked_by_policy" });
    Object.assign(h.settings, settingsFor({ connect: true }));
    expect(await h.service.getAccessToken()).toBe("ghu_access1");
  });

  it("applies managed owner/repo allowlists to tokens, listing and coverage checks", async () => {
    const h = setup({ settings: settingsFor({ allowedOwners: ["acme"] }) });
    await connect(h);
    expect((await h.service.listAccess()).flatMap((i) => i.repositories.map((r) => r.fullName))).toEqual(["acme/widgets"]);
    expect(await h.service.checkRepo("other/thing")).toMatchObject({ covered: false, reason: "not_allowed" });
    await expect(h.service.getAccessToken("other/thing")).rejects.toMatchObject({ code: "not_allowed" });
    expect(await h.service.getAccessToken("acme/widgets")).toBe("ghu_access1");
  });

  it("a fail-closed managed list denies every repository", async () => {
    const h = setup({ settings: settingsFor({ allowedRepos: ["no good"] }) });
    await connect(h);
    expect(await h.service.listAccess()).toEqual([]);
    await expect(h.service.getAccessToken("acme/widgets")).rejects.toMatchObject({ code: "not_allowed" });
  });
});

describe("fake GitHub override (test seam)", () => {
  it("rewrites github.com and api.github.com only when the env bases are set", () => {
    expect(rewriteGithubUrl("https://github.com/login/device/code", {})).toBe("https://github.com/login/device/code");
    const env = { GEODE_GITHUB_API_BASE: "http://127.0.0.1:1/", GEODE_GITHUB_WEB_BASE: "http://127.0.0.1:2" };
    expect(rewriteGithubUrl("https://github.com/login/device/code", env)).toBe("http://127.0.0.1:2/login/device/code");
    expect(rewriteGithubUrl("https://api.github.com/user", env)).toBe("http://127.0.0.1:1/user");
    expect(rewriteGithubUrl("https://example.com/x", env)).toBe("https://example.com/x");
  });
});
