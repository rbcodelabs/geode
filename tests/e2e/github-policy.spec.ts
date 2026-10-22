import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const DEFAULT_CLIENT_ID = "Iv23litirg6G1u4PLtEp";
const DEFAULT_SLUG = "geode-rb-code-labs";

interface FakeGithub {
  url: string;
  /** Every request path (with form body for POSTs) the app made, in order. */
  requests: string[];
  deviceClientIds: string[];
  close: () => Promise<void>;
}

/**
 * A fake github.com + api.github.com on one port, reached through the
 * GEODE_GITHUB_WEB_BASE / GEODE_GITHUB_API_BASE overrides. `apps` maps an App
 * slug to its client ID (the App lookup must agree with the client ID in use).
 */
async function startFakeGithub(opts: { apps: Record<string, string>; login?: string }): Promise<FakeGithub> {
  const state: FakeGithub = { url: "", requests: [], deviceClientIds: [], close: async () => {} };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.requests.push(`${req.method} ${req.url}`);
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const url = req.url ?? "";
      const app = /^\/apps\/([^/?]+)/.exec(url);
      if (app) {
        const clientId = opts.apps[app[1]];
        if (!clientId) return json(404, { message: "Not Found" });
        return json(200, {
          slug: app[1],
          name: "Fake App",
          client_id: clientId,
          owner: { login: "acme", type: "Organization" },
          permissions: { contents: "write", pull_requests: "write", metadata: "read", actions: "read", checks: "read" },
        });
      }
      if (url === "/login/device/code") {
        state.deviceClientIds.push(new URLSearchParams(body).get("client_id") ?? "");
        return json(200, { device_code: "dev", user_code: "ABCD-1234", verification_uri: "http://127.0.0.1/device", expires_in: 900, interval: 1 });
      }
      if (url === "/login/oauth/access_token") {
        return json(200, { access_token: "ghu_e2e", refresh_token: "ghr_e2e", expires_in: 28800, refresh_token_expires_in: 15811200 });
      }
      if (url === "/user") return json(200, { login: opts.login ?? "octocat" });
      return json(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

interface Ctx {
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  vaultPath: string;
  fake: FakeGithub;
}

async function launch(opts: { machinePolicy?: unknown; geodeJson?: Record<string, unknown>; fake: FakeGithub; env?: Record<string, string> }): Promise<Ctx> {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-ghpolicy-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-ghpolicy-e2e-"));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath, ...opts.geodeJson }));
  const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-ghpolicy-machine-"));
  const machinePath = path.join(policyDir, "managed-policy.json");
  if (opts.machinePolicy !== undefined) fs.writeFileSync(machinePath, JSON.stringify(opts.machinePolicy, null, 2));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEODE_POLICY_PATH: machinePath,
    GEODE_GITHUB_API_BASE: opts.fake.url,
    GEODE_GITHUB_WEB_BASE: opts.fake.url,
    ...opts.env,
  };
  // Headless Linux has no keyring; the basic store keeps safeStorage (and so GitHub sign-in) usable in CI.
  const args = [repoRoot, `--user-data-dir=${userDataDir}`, ...(process.platform === "linux" ? ["--password-store=basic"] : [])];
  const app = await electron.launch({ args, cwd: repoRoot, env });
  const window = await app.firstWindow();
  await expect(window.locator(".workspace")).toBeVisible();
  await window.waitForFunction(() => Boolean((window as unknown as { app?: { commands?: unknown } }).app?.commands));
  return { app, window, userDataDir, vaultPath, fake: opts.fake };
}

async function cleanup(ctx: Ctx) {
  await ctx.app.close();
  await ctx.fake.close();
  fs.rmSync(ctx.userDataDir, { recursive: true, force: true });
  fs.rmSync(ctx.vaultPath, { recursive: true, force: true });
}

async function openGithubSettings(window: Page): Promise<void> {
  await window.evaluate(() => (window as unknown as { app: any }).app.commands.execute("open-settings"));
  await window.locator(".vertical-tab-nav-item", { hasText: "GitHub" }).click();
  await expect(window.locator(".github-app-card")).toBeVisible();
}

const api = <T>(window: Page, fn: string, ...args: unknown[]): Promise<T> =>
  window.evaluate(([name, a]) => (window as any).geode.githubAuth[name as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;

test("baseline: with no policy the form is editable, saves, and sign-in uses the default App", async () => {
  const fake = await startFakeGithub({ apps: { [DEFAULT_SLUG]: DEFAULT_CLIENT_ID } });
  const ctx = await launch({ fake });
  try {
    await openGithubSettings(ctx.window);
    await expect(ctx.window.locator(".github-app-card input").first()).toBeEnabled();
    await expect(ctx.window.locator(".github-managed-note:visible")).toHaveCount(0);
    const saved = await api<{ ok: boolean }>(ctx.window, "setSettings", { allowedOwners: ["acme"] });
    expect(saved.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, "geode.json"), "utf8")).github).toEqual({ allowedOwners: ["acme"] });

    const started = await api<{ ok: boolean; message?: string }>(ctx.window, "start");
    expect(started.message ?? "").not.toContain("administrator policy");
    expect(started.ok).toBe(true);
    expect(fake.deviceClientIds).toEqual([DEFAULT_CLIENT_ID]);
  } finally {
    await cleanup(ctx);
  }
});

test("settingsLocked: the form is read-only with a managed note and set-settings is refused in main", async () => {
  const fake = await startFakeGithub({ apps: {} });
  const ctx = await launch({ fake, machinePolicy: { policyVersion: 1, github: { settingsLocked: true } } });
  try {
    await openGithubSettings(ctx.window);
    const inputs = ctx.window.locator(".github-app-card input");
    await expect(inputs).toHaveCount(4);
    for (let i = 0; i < 4; i++) await expect(inputs.nth(i)).toBeDisabled();
    await expect(ctx.window.locator(".github-app-card button", { hasText: "Save" })).toBeDisabled();
    await expect(ctx.window.locator(".github-app-card .github-managed-note")).toContainText("Managed by your administrator");

    // The renderer is not the boundary: calling the IPC directly is refused by the main process.
    const refused = await api<{ ok: boolean; blockedByPolicy?: boolean; message?: string }>(ctx.window, "setSettings", { appSlug: "evil-app", clientId: "Iv-evil" });
    expect(refused).toMatchObject({ ok: false, blockedByPolicy: true });
    expect(refused.message).toContain("blocked by administrator policy: github");
    const reset = await api<{ ok: boolean }>(ctx.window, "setSettings", { reset: true });
    expect(reset.ok).toBe(false);
    const written = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, "geode.json"), "utf8"));
    expect(written.github).toBeUndefined();
  } finally {
    await cleanup(ctx);
  }
});

test("a pinned clientId/appSlug beats env and geode.json and is what the device flow uses", async () => {
  const fake = await startFakeGithub({ apps: { "corp-geode": "Iv-corp" } });
  const ctx = await launch({
    fake,
    machinePolicy: { policyVersion: 1, github: { clientId: "Iv-corp", appSlug: "corp-geode" } },
    geodeJson: { github: { clientId: "Iv-user", appSlug: "user-app" } },
    env: { GEODE_GITHUB_CLIENT_ID: "Iv-env", GEODE_GITHUB_APP_SLUG: "env-app" },
  });
  try {
    const view = await api<{ clientId: { value: string; source: string }; appSlug: { value: string; source: string } }>(ctx.window, "getSettings");
    expect(view.clientId).toEqual({ value: "Iv-corp", source: "policy" });
    expect(view.appSlug).toEqual({ value: "corp-geode", source: "policy" });
    // Not locked: the user may still save to geode.json, but it cannot take effect.
    const saved = await api<{ ok: boolean; settings?: { clientId: { value: string } } }>(ctx.window, "setSettings", { clientId: "Iv-other" });
    expect(saved.ok).toBe(true);
    expect(saved.settings?.clientId.value).toBe("Iv-corp");

    const started = await api<{ ok: boolean; message?: string }>(ctx.window, "start");
    expect(started.message ?? "").toBe("");
    expect(started.ok).toBe(true);
    expect(fake.deviceClientIds).toEqual(["Iv-corp"]);
    expect(fake.requests.some((r) => r.startsWith("GET /apps/corp-geode"))).toBe(true);
    expect(fake.requests.some((r) => r.includes("env-app") || r.includes("user-app"))).toBe(false);

    await openGithubSettings(ctx.window);
    await expect(ctx.window.locator(".github-app-notes")).toContainText("pinned by your administrator");
  } finally {
    await cleanup(ctx);
  }
});

test("connect:false refuses sign-in in main and the UI shows the managed state", async () => {
  const fake = await startFakeGithub({ apps: { [DEFAULT_SLUG]: DEFAULT_CLIENT_ID } });
  const ctx = await launch({ fake, machinePolicy: { policyVersion: 1, github: { connect: false } } });
  try {
    const started = await api<{ ok: boolean; code?: string; message?: string }>(ctx.window, "start");
    expect(started).toMatchObject({ ok: false, code: "blocked_by_policy" });
    expect(started.message).toContain("blocked by administrator policy: github");
    expect(fake.requests).toEqual([]);

    await openGithubSettings(ctx.window);
    await expect(ctx.window.locator(".github-connect-card .github-managed-note")).toContainText("Managed by your administrator");
    await expect(ctx.window.locator(".github-connect-card button", { hasText: /Connect GitHub/ })).toHaveCount(0);
  } finally {
    await cleanup(ctx);
  }
});

test("allowedLogins: an account that does not match is rejected after sign-in and no token is kept", async () => {
  const fake = await startFakeGithub({ apps: { [DEFAULT_SLUG]: DEFAULT_CLIENT_ID }, login: "mallory" });
  const ctx = await launch({ fake, machinePolicy: { policyVersion: 1, github: { allowedLogins: ["*_corp-emu"] } } });
  try {
    expect((await api<{ ok: boolean }>(ctx.window, "start")).ok).toBe(true);
    await expect
      .poll(async () => (await api<{ state: string; message?: string }>(ctx.window, "status")).state, { timeout: 20_000 })
      .toBe("error");
    const status = await api<{ message: string }>(ctx.window, "status");
    expect(status.message).toContain("blocked by administrator policy: github");
    expect(status.message).toContain("mallory");
    const token = await api<{ ok: boolean; code?: string }>(ctx.window, "getToken");
    expect(token.ok).toBe(false);
  } finally {
    await cleanup(ctx);
  }
});
