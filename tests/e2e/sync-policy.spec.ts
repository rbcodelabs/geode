import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
test.setTimeout(120_000);

/**
 * Managed sync policy (docs/adr/0053-sync-policy.md): `sync.enabled`, `sync.providers` and `sync.hubAllowlist` for the in-app
 * providers, read from GEODE_POLICY_PATH. Enforcement is in the main-process handlers; the renderer only shows the note.
 */
interface Ctx { app: ElectronApplication; page: Page; policyFile: string; dirs: string[] }

async function launch(policy: unknown | undefined): Promise<Ctx> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sync-policy-e2e-"));
  const vault = path.join(base, "vault"), profile = path.join(base, "profile");
  fs.mkdirSync(vault, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(vault, "Note.md"), "hello");
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const policyFile = path.join(base, "managed-policy.json");
  if (policy !== undefined) fs.writeFileSync(policyFile, JSON.stringify(policy));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${profile}`], cwd: repoRoot, env: { ...process.env, GEODE_HEADLESS: "1", GEODE_POLICY_PATH: policyFile } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => (window as any).app?.sync?.listProviders().some((provider: any) => provider.id === "geode.hub"));
  return { app, page, policyFile, dirs: [base] };
}

async function close(ctx: Ctx) {
  await ctx.app.close().catch(() => {});
  for (const dir of ctx.dirs) fs.rmSync(dir, { recursive: true, force: true });
}

async function openSyncTab(page: Page) {
  await page.evaluate(() => (window as any).app.setting.openTabById("sync"));
  const modal = page.locator('.modal.mod-settings[aria-label="Settings"]');
  await expect(modal.getByRole("heading", { name: "Sync" })).toBeVisible();
  return modal;
}

/** Run the preload's sync-related calls from the page and return either the value or the rejection message. */
async function callMain(page: Page, name: "claimSyncOwner" | "scanForSync" | "scanForSyncBlocked" | "privateSyncStorage" | "applySyncMutation" | "releaseSyncOwner" | "hubProbeFolder" | "icloud", args: unknown[] = []) {
  return page.evaluate(async ({ name, args }) => {
    const geode = (window as any).geode;
    try {
      if (name === "hubProbeFolder") return { value: await geode.hubSync.call({ method: "probe", target: { kind: "fs", path: "/tmp" }, create: false }, "e2e-1") };
      if (name === "icloud") {
        if (!geode.icloudContainer) return { value: "no-icloud-bridge" };
        return { value: await geode.icloudContainer.call("listRoots", [], "e2e-2") };
      }
      return { value: await geode[name](...args) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, { name, args });
}

const BLOCKED = /blocked by administrator policy: sync/;

test("baseline: with no policy, sync is unchanged (no managed note, owner claim works)", async () => {
  const ctx = await launch(undefined);
  try {
    const modal = await openSyncTab(ctx.page);
    await expect(modal.getByRole("combobox", { name: "Sync provider" })).toBeEnabled();
    await expect(modal.locator("[data-sync-policy-note]")).toHaveCount(0);
    const claimed = await callMain(ctx.page, "claimSyncOwner");
    expect(typeof claimed.value).toBe("string");
    await callMain(ctx.page, "releaseSyncOwner", [claimed.value]);
    const probe = await callMain(ctx.page, "hubProbeFolder");
    expect(JSON.stringify(probe)).not.toMatch(/policy-blocked/);
  } finally { await close(ctx); }
});

test("sync.enabled=false: the main process refuses every sync channel and the Sync pane shows the managed note", async () => {
  const ctx = await launch({ policyVersion: 1, sync: { enabled: false } });
  try {
    for (const name of ["claimSyncOwner", "scanForSync", "scanForSyncBlocked"] as const) {
      const result = await callMain(ctx.page, name);
      expect(result.error, name).toMatch(BLOCKED);
    }
    expect((await callMain(ctx.page, "privateSyncStorage", ["tok", "a".repeat(64), { action: "load-operations" }])).error).toMatch(BLOCKED);
    expect((await callMain(ctx.page, "applySyncMutation", ["tok", { kind: "mkdir", path: "X", namespace: "content" }])).error).toMatch(BLOCKED);
    const hub = await callMain(ctx.page, "hubProbeFolder");
    expect(hub.value).toMatchObject({ ok: false, error: { code: "policy-blocked" } });
    expect(JSON.stringify(hub.value)).toMatch(BLOCKED);
    const icloud = await callMain(ctx.page, "icloud");
    if (icloud.value !== "no-icloud-bridge") expect(JSON.stringify(icloud.value)).toMatch(BLOCKED);

    const modal = await openSyncTab(ctx.page);
    const note = modal.locator("[data-sync-policy-note]");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Managed by your administrator");
    await expect(note).toContainText("Sync is turned off");
    await expect(modal.getByRole("combobox", { name: "Sync provider" })).toBeDisabled();
    // Nothing was deleted: the note and the vault are untouched.
    expect(fs.readdirSync(path.join(ctx.dirs[0]!, "vault")).includes("Note.md")).toBe(true);
  } finally { await close(ctx); }
});

test("a mid-session policy change refuses new operations, lets the owner lease be released, and re-enabling resumes", async () => {
  const ctx = await launch(undefined);
  try {
    const token = (await callMain(ctx.page, "claimSyncOwner")).value as string;
    expect(typeof token).toBe("string");
    fs.writeFileSync(ctx.policyFile, JSON.stringify({ policyVersion: 1, sync: { enabled: false } }));
    expect((await callMain(ctx.page, "privateSyncStorage", [token, "a".repeat(64), { action: "load-operations" }])).error).toMatch(BLOCKED);
    expect((await callMain(ctx.page, "claimSyncOwner")).error).toMatch(BLOCKED);
    expect((await callMain(ctx.page, "releaseSyncOwner", [token])).error, "release must stay allowed so the lease can end cleanly").toBeUndefined();
    fs.rmSync(ctx.policyFile);
    const again = await callMain(ctx.page, "claimSyncOwner");
    expect(typeof again.value).toBe("string");
    await callMain(ctx.page, "releaseSyncOwner", [again.value]);
  } finally { await close(ctx); }
});

test("sync.providers without hub refuses the hub channel and greys the provider out; icloud-only narrowing leaves hub usable", async () => {
  const ctx = await launch({ policyVersion: 1, sync: { providers: ["icloud"] } });
  try {
    const hub = await callMain(ctx.page, "hubProbeFolder");
    expect(JSON.stringify(hub.value)).toMatch(/provider \\"hub\\" is not permitted|provider "hub" is not permitted/);
    const modal = await openSyncTab(ctx.page);
    await expect(modal.locator("[data-sync-policy-note]")).toContainText("Sync providers are limited to: icloud");
    await expect(modal.getByRole("combobox", { name: "Sync provider" }).locator('option[value="geode.hub"]')).toBeDisabled();
  } finally { await close(ctx); }
});

test("sync.hubAllowlist: a non-allowed HTTPS hub is refused before any connection; folder hubs are refused in main; an allowed hub passes the policy", async () => {
  // A local server standing in for the disallowed hub: it must see zero connections.
  let connections = 0;
  const server = net.createServer((socket) => { connections++; socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const hubUrl = `https://127.0.0.1:${port}`;
  const ctx = await launch({ policyVersion: 1, sync: { hubAllowlist: ["https://hub.corp.example"] } });
  try {
    const folder = await callMain(ctx.page, "hubProbeFolder");
    expect(folder.value).toMatchObject({ ok: false, error: { code: "policy-blocked" } });

    const modal = await openSyncTab(ctx.page);
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("geode.hub");
    await expect(modal.locator("[data-sync-policy-hubs]")).toContainText("https://hub.corp.example");
    await expect(modal.getByRole("combobox", { name: "Hub type" }).locator('option[value="fs"]')).toBeDisabled();
    await modal.getByRole("combobox", { name: "Hub type" }).selectOption("http");
    await modal.getByRole("textbox", { name: "Hub URL" }).fill(hubUrl);
    const result = modal.locator("[data-hub-result]");
    await modal.getByRole("button", { name: "Test connection" }).click();
    await expect(result).toContainText("blocked by administrator policy: sync");
    await expect(result).toContainText("is not on the allowed hub list");
    expect(connections, "a refused hub is never dialled").toBe(0);

    // Positive control: the same hub, once allowed, gets past the policy (it then fails for its own, non-policy reason).
    fs.writeFileSync(ctx.policyFile, JSON.stringify({ policyVersion: 1, sync: { hubAllowlist: [hubUrl] } }));
    await modal.getByRole("button", { name: "Test connection" }).click();
    await expect(result).not.toContainText("Connecting...");
    await expect(result).not.toContainText("blocked by administrator policy");
  } finally { await close(ctx); server.close(); }
});
