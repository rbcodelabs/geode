import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { PairingService } from "../../src/main/pairing-service";
import { PAIRING_PROVIDER_HUB, type PairingBundle } from "../../src/shared/pairing/bundle";
import { redeemInvitation } from "../../src/shared/pairing/client";
import { parseInvitation } from "../../src/shared/pairing/invitation";

const mobileUrl = pathToFileURL(path.resolve(__dirname, "../../dist/mobile/index.html")).href;
const bundle = (): PairingBundle => ({
  v: 1, provider: { id: PAIRING_PROVIDER_HUB, config: { url: "https://claude-box.example.ts.net/" } }, vault: { id: "123e4567-e89b-42d3-a456-426614174000", name: "Personal notes" },
  portable: { editor: { readableLineLength: false, foldHeading: true, showLineNumber: true, showRibbon: true, showStatusBar: true } },
  credential: { scheme: "bearer", value: "paired-hub-token-9876" }, from: "Rick's Mac",
});

// The shipped mobile CSP (connect-src 'self' wss:) stays closed: on iOS the redeem request goes through native CapacitorHttp, which the
// WebView CSP does not govern. The browser build used here has no native transport, so the harness bypasses CSP for its one local request.
test.use({ bypassCSP: true });

/** The phone host the proof page lacks: guarded sync (recording portable-config applies) and, optionally, an in-memory Keychain. */
async function phoneHost(page: Page, options: { keychain: boolean }): Promise<void> {
  await page.addInitScript((keychain: boolean) => {
    let installed: unknown;
    const secrets = new Map<string, string>(); const applies: unknown[] = [];
    Object.assign(window, { __appSecrets: secrets, __applies: applies });
    Object.defineProperty(window, "hostServices", { configurable: true, get: () => installed, set: (host: Record<string, unknown>) => {
      host.syncSafety = { claimOwner: async () => "lease", releaseOwner: async () => {}, apply: async (_t: string, input: { namespace: string; path: string; expectedHash: string; kind: string }) => { applies.push({ namespace: input.namespace, path: input.path, kind: input.kind, guarded: typeof input.expectedHash === "string" }); return { status: "applied", hash: null, recoveryPath: "" }; },
        storage: async (_t: string, _b: string, request: { action: string }) => request.action === "load-operations" ? [] : undefined, onPrepare: () => () => {}, onRelease: () => () => {} };
      if (keychain) host.secrets = { ...(host.secrets as object), appAvailable: true, app: { get: async (key: string) => secrets.get(key) ?? null, set: async (key: string, value: string) => { secrets.set(key, value); }, remove: async (key: string) => { secrets.delete(key); } } };
      installed = host;
    } });
  }, options.keychain);
  await page.goto(mobileUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

/** A real desktop session server on loopback. The page is file://, whose opaque origin a CORS allow-list rightly refuses, so requests
 * to it are relayed through Node (which adds the CORS header the WKWebView origin would get); the server logic is the shipped code. */
async function desktop(page: Page) {
  const service = new PairingService({ addresses: () => ["127.0.0.1"], bindHost: "127.0.0.1" });
  const { invitation } = await service.start("test", bundle());
  await page.route(/http:\/\/127\.0\.0\.1:\d+\/geode-pair\/.*/, async route => {
    const request = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const response = await fetch(request.url(), { method: request.method(), headers: { "content-type": "application/json", origin: "capacitor://localhost" }, body: request.postData() ?? undefined }).catch(() => null);
    if (!response) return route.abort("connectionrefused");
    await route.fulfill({ status: response.status, headers: { "content-type": "application/json", ...cors }, body: await response.text() });
  });
  return { service, invitation };
}

async function openSync(page: Page): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Mobile navigation" });
  await nav.getByRole("button", { name: "More" }).click();
  await page.locator(".menu.mod-mobile-more").getByText("Settings", { exact: true }).click();
  await page.locator(".modal.mod-settings").getByText("Sync", { exact: true }).first().click();
}
const state = (page: Page) => page.evaluate(() => ({ secrets: [...(window as unknown as { __appSecrets: Map<string, string> }).__appSecrets], applies: (window as unknown as { __applies: unknown[] }).__applies, web: JSON.stringify({ ...localStorage }) + document.cookie }));

test("@phone pasting a code shows what will change, then stores the token in the Keychain only after confirmation", async ({ page }) => {
  await phoneHost(page, { keychain: true });
  const { service, invitation } = await desktop(page);
  await openSync(page);
  const panel = page.locator("[data-pairing-phone]");
  await expect(panel).toBeVisible();
  await panel.getByRole("textbox", { name: "Pairing code" }).fill(invitation);
  await panel.getByRole("button", { name: "Set up", exact: true }).click();

  const sheet = page.getByRole("group", { name: "Confirm pairing" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("claude-box.example.ts.net");
  await expect(sheet).toContainText("Personal notes (123e4567)");
  await expect(sheet).toContainText("Editor");
  await expect(sheet).toContainText("Keychain");
  await expect(sheet).not.toContainText("paired-hub-token-9876");
  expect((await state(page)).secrets).toEqual([]); // nothing is written before the user confirms
  expect((await state(page)).applies).toEqual([]);

  await sheet.getByRole("button", { name: "Set up", exact: true }).click();
  await expect(page.locator(".sync-status-card")).toContainText("Hub token saved to Keychain");
  await expect(page.locator(".sync-status-card")).toContainText("join the shared vault \"Personal notes\"");
  const after = await state(page);
  expect(after.secrets).toEqual([["hub-token/claude-box.example.ts.net", "paired-hub-token-9876"]]);
  expect(after.applies).toEqual([{ namespace: "portable-config", path: "editor.json", kind: "write", guarded: true }]); // via the guarded portable-config path
  expect(after.web).not.toContain("paired-hub-token-9876");
  expect(service.liveCount).toBe(0); // single use: the desktop session is gone

  // The same code cannot be replayed.
  await page.locator("[data-pairing-phone]").getByRole("textbox", { name: "Pairing code" }).fill(invitation);
  await page.locator("[data-pairing-phone]").getByRole("button", { name: "Set up", exact: true }).click();
  await expect(page.locator("[data-pairing-phone-status]")).toContainText(/expired|already used|Couldn't reach/);
});

test("@phone declining the confirmation stores nothing", async ({ page }) => {
  await phoneHost(page, { keychain: true });
  const { invitation } = await desktop(page);
  await openSync(page);
  const panel = page.locator("[data-pairing-phone]");
  await panel.getByRole("textbox", { name: "Pairing code" }).fill(invitation);
  await panel.getByRole("button", { name: "Set up", exact: true }).click();
  await page.getByRole("group", { name: "Confirm pairing" }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-pairing-phone-status]")).toContainText("Nothing was changed");
  const after = await state(page);
  expect(after.secrets).toEqual([]); expect(after.applies).toEqual([]); expect(after.web).not.toContain("claude-box");
});

test("@phone without a Keychain the flow fails closed before redeeming, so the code is not spent", async ({ page }) => {
  await phoneHost(page, { keychain: false });
  const { service, invitation } = await desktop(page);
  await openSync(page);
  const panel = page.locator("[data-pairing-phone]");
  await panel.getByRole("textbox", { name: "Pairing code" }).fill(invitation);
  await panel.getByRole("button", { name: "Set up", exact: true }).click();
  await expect(page.locator("[data-pairing-phone-status]")).toContainText("can't store the hub token securely");
  expect(service.liveCount).toBe(1); // token not burned
  expect((await state(page)).web).not.toContain("paired-hub-token");
  service.closeAll();
});

test("@phone a malformed or foreign code is rejected with nothing sent", async ({ page }) => {
  await phoneHost(page, { keychain: true });
  const requests: string[] = []; page.on("request", r => { if (r.url().startsWith("http://")) requests.push(r.url()); });
  await openSync(page);
  const panel = page.locator("[data-pairing-phone]");
  await panel.getByRole("textbox", { name: "Pairing code" }).fill("https://example.com/not-geode");
  await panel.getByRole("button", { name: "Set up", exact: true }).click();
  await expect(page.locator("[data-pairing-phone-status]")).toContainText("isn't a valid Geode pairing code");
  expect(requests).toEqual([]);
});

// ---- Desktop side ("Pair mobile device") ------------------------------------------------------------------------------
// The real desktop card, bundle builder and session server run here; only the Electron IPC hop is replaced by exposed functions,
// because the harness page is the mobile bundle in Chromium. (The preload/ipcMain wiring is covered by typecheck + unit tests.)
async function desktopCardPage(page: Page) {
  await phoneHost(page, { keychain: true });
  const service = new PairingService({ addresses: () => ["127.0.0.1"], bindHost: "127.0.0.1", onEvent: (_o, event) => { void page.evaluate(e => (window as unknown as { __pairingHandler?: (e: unknown) => void }).__pairingHandler?.(e), event); } });
  await page.exposeFunction("__pairingStart", async (b: PairingBundle) => { try { return { ok: true, value: await service.start("w", b) }; } catch (e) { return { ok: false, error: { code: "x", message: (e as Error).message } }; } });
  await page.exposeFunction("__pairingCancel", () => service.cancel("w"));
  await page.waitForFunction(() => Boolean((window as unknown as { geode?: unknown }).geode));
  await page.evaluate(() => {
    const w = window as unknown as { geode: Record<string, unknown>; __pairingHandler?: (e: unknown) => void; __pairingStart: (b: unknown) => Promise<unknown>; __pairingCancel: () => Promise<void> };
    w.geode.pairing = { start: (b: unknown) => w.__pairingStart(b), cancel: () => w.__pairingCancel(), onEvent: (h: (e: unknown) => void) => { w.__pairingHandler = h; return () => { w.__pairingHandler = undefined; }; } };
  });
  await openSync(page);
  await page.getByRole("combobox", { name: "Sync provider" }).selectOption("geode.hub");
  await page.getByRole("textbox", { name: "Hub URL" }).fill("https://claude-box.example.ts.net");
  const token = page.getByLabel("Hub token"); await token.fill("desktop-hub-token-555"); await token.blur();
  await expect(page.locator("[data-hub-result]")).toContainText("Hub settings saved");
  return service;
}

test("@phone the desktop card shows a single-use code that carries no secret, and reports when it was redeemed", async ({ page }) => {
  const service = await desktopCardPage(page);
  const card = page.locator("[data-pairing-card]");
  await expect(card).toContainText("Pair mobile device");
  await card.getByRole("button", { name: "Show pairing code" }).click();
  await expect(card.locator("[data-pairing-qr] svg")).toBeVisible();
  await expect(card.locator("[data-pairing-countdown]")).toContainText(/Expires in [0-3]:\d\d/);
  const code = (await card.locator("[data-pairing-code]").textContent())!;
  const invite = parseInvitation(code);
  expect(invite.addresses[0]).toMatch(/^127\.0\.0\.1:\d+$/);
  expect(code + JSON.stringify(invite)).not.toMatch(/desktop-hub-token-555|claude-box/); // the code holds neither the token nor the hub URL
  expect(service.liveCount).toBe(1);

  const { bundle: delivered } = await redeemInvitation(code);
  expect(delivered.provider.config.url).toBe("https://claude-box.example.ts.net/");
  expect(delivered.credential).toEqual({ scheme: "bearer", value: "desktop-hub-token-555" });
  expect(Object.keys(delivered.portable).sort()).toEqual(["appearance", "dailyNotes", "editor", "hotkeys"]);
  await expect(page.locator("[data-pairing-status]")).toContainText("Paired");
  await expect(card.locator("[data-pairing-qr]")).toHaveCount(0);
  expect(service.liveCount).toBe(0);
});

test("@phone cancelling the desktop code revokes it immediately", async ({ page }) => {
  const service = await desktopCardPage(page);
  const card = page.locator("[data-pairing-card]");
  await card.getByRole("button", { name: "Show pairing code" }).click();
  const code = (await card.locator("[data-pairing-code]").textContent())!;
  await card.getByRole("button", { name: "Cancel code" }).click();
  await expect(card.locator("[data-pairing-qr]")).toHaveCount(0);
  await expect(page.locator("[data-pairing-status]")).toContainText("cancelled");
  expect(service.liveCount).toBe(0);
  await expect(redeemInvitation(code, { timeoutMs: 1500 })).rejects.toMatchObject({ code: "unreachable" });
});
