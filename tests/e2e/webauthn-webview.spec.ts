import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * Live-code verification of Compass assumption `7919ff78-bf30-44bd-bd5a-e7812a51b3d8`
 * (do WebAuthn ceremonies work inside the embedded `<webview>` at all) against
 * a REAL, unmodified relying party — webauthn.io, a public demo site built
 * specifically for testing WebAuthn/passkey registration and authentication.
 * Not a mocked `navigator.credentials` API: this attaches Chromium's real
 * WebAuthn CDP domain (a genuine software authenticator implementation) to
 * the guest `<webview>`'s own WebContents and drives webauthn.io's actual
 * registration UI.
 *
 * Requires network access to https://webauthn.io. If that's unavailable
 * (offline dev machine, restricted CI egress), this test fails with a
 * network error rather than a false pass — it is intentionally not mocked
 * or skipped silently, per the build package's "no fabricated pass" rule.
 *
 * Finding from building this test (see PR description for the full
 * writeup): registration (`navigator.credentials.create()`) reliably
 * completes inside Geode's embedded `<webview>` against webauthn.io,
 * confirmed both by webauthn.io's own success UI text and by the ground-
 * truth `WebAuthn.credentialAdded` CDP event Chromium emits when the
 * ceremony actually completes. webauthn.io's own "Authenticate"
 * (`navigator.credentials.get()`) button did not reliably invoke the
 * WebAuthn API in automated testing (traced to that specific page's own
 * client-side session handling across a scripted flow, not to anything
 * webview-specific — no `WebAuthn.credentialAsserted` CDP event was ever
 * observed even to FAIL, meaning the call was never made) — so the
 * authentication half of the ceremony is instead covered against a fully
 * controlled local fixture in tests/e2e/webauthn-escalation.spec.ts,
 * which exercises the real API without depending on a third party's exact
 * client-side implementation.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultPath = path.join(repoRoot, "test-vault");
const WEBAUTHN_IO_URL = "https://webauthn.io/";

test.setTimeout(60_000);

test("a real WebAuthn registration ceremony completes inside the embedded Web Viewer against webauthn.io", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-webauthn-webview-e2e-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [testVaultPath], lastVault: testVaultPath })
  );
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await expect(window.locator(".workspace")).toBeVisible();
  await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);

  try {
    await window.evaluate(async (url) => {
      const geodeApp = (window as any).app;
      const leaf = geodeApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "webviewer", active: true, state: { url } });
      (window as any).__webauthnLeaf = leaf;
    }, WEBAUTHN_IO_URL);

    const frame = window.locator(".workspace-split.mod-root .workspace-leaf.mod-active .web-view-frame");
    await frame.waitFor({ state: "visible" });

    let guestId: number | null = null;
    await expect
      .poll(
        async () => {
          const guestUrl = await frame
            .evaluate((guest) => (guest as unknown as { getURL(): string }).getURL())
            .catch(() => "");
          if (guestUrl.startsWith(WEBAUTHN_IO_URL)) {
            guestId = await frame.evaluate((guest) =>
              (guest as unknown as { getWebContentsId(): number }).getWebContentsId()
            );
            return true;
          }
          return false;
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    expect(guestId).not.toBeNull();

    // Attach the WebAuthn CDP domain to the GUEST's own WebContents (not the
    // host window) and install a real virtual authenticator — genuine
    // Chromium authenticator behavior, not a stub of navigator.credentials.
    const authenticatorId = await app.evaluate(async ({ webContents }, id) => {
      const guest = webContents.fromId(id);
      if (!guest) throw new Error("Guest WebContents not found");
      guest.debugger.attach("1.3");
      await guest.debugger.sendCommand("WebAuthn.enable", { enableUI: false });
      const result = await guest.debugger.sendCommand("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      return (result as { authenticatorId: string }).authenticatorId;
    }, guestId);
    expect(authenticatorId).toBeTruthy();

    const username = `geode-e2e-${Date.now()}`;
    const registerResult = await app.evaluate(
      async ({ webContents }, { id, username }) => {
        const guest = webContents.fromId(id);
        if (!guest) throw new Error("Guest WebContents not found");
        return guest.executeJavaScript(`
          (async () => {
            const input = document.querySelector('input[name="username"], #input-email, input[type="text"]');
            if (!input) return { ok: false, error: "no username input found" };
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            setter.call(input, ${JSON.stringify(username)});
            input.dispatchEvent(new Event("input", { bubbles: true }));
            const registerBtn = [...document.querySelectorAll("button")].find(b => /register/i.test(b.textContent || ""));
            if (!registerBtn) return { ok: false, error: "no register button found" };
            registerBtn.click();
            for (let i = 0; i < 15; i++) {
              await new Promise(r => setTimeout(r, 1000));
              if (/success/i.test(document.body.innerText)) break;
            }
            return { ok: true, bodyText: document.body.innerText.slice(0, 400) };
          })()
        `);
      },
      { id: guestId, username }
    );
    expect((registerResult as { ok: boolean }).ok).toBe(true);
    expect((registerResult as { bodyText: string }).bodyText).toMatch(/success/i);

    // Ground truth, independent of webauthn.io's own UI text: ask
    // Chromium's real WebAuthn implementation what the virtual
    // authenticator actually holds — a credential exists only if a genuine
    // create() ceremony completed.
    const credentials = await app.evaluate(
      async ({ webContents }, { id, authenticatorId }) => {
        const guest = webContents.fromId(id);
        if (!guest) throw new Error("Guest WebContents not found");
        return guest.debugger.sendCommand("WebAuthn.getCredentials", { authenticatorId });
      },
      { id: guestId, authenticatorId }
    );
    expect((credentials as { credentials: unknown[] }).credentials.length).toBeGreaterThan(0);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
