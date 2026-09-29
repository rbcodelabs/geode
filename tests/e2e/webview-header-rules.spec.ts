import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * Secret-backed request-header rules for the agent browser, end to end
 * against a real `<webview>` guest — see:
 * "Browser Header Rules.md" §5.2 (matching), §9 ("Geode e2e" — the exact
 * assertion list below is that list), and §12 ("UNVERIFIED").
 *
 * Unlike `webview-client-hints.spec.ts`'s plain loopback HTTP servers,
 * `matchRule` (browser-header-rules.ts §5.2 step 1) is HTTPS-only and rejects
 * IP-literal hosts, so this harness needs two self-signed HTTPS loopback
 * origins on two distinct hostnames. `a.test`/`b.test` are IANA-reserved for
 * testing (RFC 2606), never resolve on a real network, and are real
 * hostnames rather than IP literals, so they clear `matchRule`'s IP-literal
 * gate cleanly. Electron is launched with `--ignore-certificate-errors` (the
 * cert is self-signed) and `--host-resolver-rules` mapping both names to
 * `127.0.0.1`, per design §9's own testing-plan prescription; the servers
 * still listen on OS-assigned ports, since `--host-resolver-rules` maps
 * hostname to IP, not hostname to port.
 *
 * One rule is created for `a.test` only (host, header `x-probe-secret`, a
 * throwaway secret value chosen to be implausible as an incidental header —
 * `probe-secret-9f3a` — so a failed scrub assertion can't produce a false
 * pass). Every assertion below is checked against that single rule.
 */

const repoRoot = path.resolve(__dirname, "..", "..");

const PROBE_HEADER = "x-probe-secret";
const PROBE_SECRET_VALUE = "probe-secret-9f3a";
const PROBE_SECRET_ID = "ct-secret-probe-test";

/** PR #248's low-entropy client hints — the pipeline-composition regression guard (design §9 bullet 6). */
const LOW_ENTROPY_CLIENT_HINTS = ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"] as const;

type Recorded = { path: string; headers: IncomingHttpHeaders };

/**
 * The subset of `window.geode` this spec touches, declared locally (rather
 * than relying on the ambient `Window.geode` augmentation in
 * `src/renderer/types.ts`, which this file — under `tests/e2e/` — is not
 * guaranteed to see) so the file type-checks standalone. `browserHeaderRules`
 * and `setSecret` are optional on the real `GeodeApi` (absent on the
 * mobile/browser facade), hence the `!` at every call site below, matching
 * `window.geode.externalRoots!` in `external-root-management.spec.ts`.
 */
type GeodeTestWindow = Window & {
  geode: {
    setSecret?: (id: string, value: string) => Promise<void>;
    browserHeaderRules?: {
      list: () => Promise<
        Array<{
          id: string;
          host: string;
          header: string;
          secretId: string;
          secretPresent: boolean;
          createdBy: "user" | "agent";
          expiresAt?: string;
        }>
      >;
      add: (input: unknown) => Promise<
        | { success: true; ruleId: string; host: string; header: string; expiresAt?: string }
        | { success: false; status: "invalid"; message: string }
        | { success: false; status: "declined" }
      >;
      remove: (id: string) => Promise<boolean>;
    };
  };
};

type GuestWebview = HTMLElement & { loadURL(url: string): Promise<void> };

/**
 * A throwaway self-signed cert covering BOTH `a.test` and `b.test` in one SAN
 * list, generated via `openssl` (no cert-gen npm package is installed, and
 * none should be added for one test). Verified manually before wiring this
 * in — see the task report for the exact command and its output. Both
 * loopback servers share this single cert/key pair, so openssl runs once.
 */
function generateSelfSignedCert(): { certDir: string; cert: string; key: string } {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-header-rules-cert-"));
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=a.test",
    "-addext",
    "subjectAltName=DNS:a.test,DNS:b.test",
  ]);
  return { certDir, cert: fs.readFileSync(certPath, "utf8"), key: fs.readFileSync(keyPath, "utf8") };
}

async function listenHttps(server: https.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

test("secret-backed header rules match, scrub across redirects, and respect the initiator gate", async () => {
  // Two self-signed HTTPS servers plus a real Electron launch and several
  // full-page guest navigations comfortably exceed the default 45s budget.
  test.setTimeout(120_000);

  const { certDir, cert, key } = generateSelfSignedCert();
  // Filled in once both servers are listening; the redirect target and the
  // cross-origin <img> src both need the OTHER origin's OS-assigned port, so
  // request handlers read this object rather than a captured literal.
  const ports = { a: 0, b: 0 };
  const recordedA: Recorded[] = [];
  const recordedB: Recorded[] = [];

  const serverA = https.createServer({ cert, key }, (req, res) => {
    const url = req.url ?? "";
    recordedA.push({ path: url, headers: req.headers });
    if (url === "/doc") {
      res.writeHead(200, { "content-type": "text/html" });
      // Same-origin fetch: a genuine subresource load (not another top-level
      // navigation), so it actually exercises the initiator-gate's "allow"
      // path (design §9 assertion 5) rather than just the mainFrame path.
      res.end("<!doctype html><title>a.test doc</title><h1>a.test doc</h1><script>fetch('/xhr');</script>");
      return;
    }
    if (url === "/xhr") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (url === "/redirect-to-b") {
      // Leg 1 lands here (on a.test, so the rule matches); leg 2 lands on
      // b.test's /after-redirect below.
      res.writeHead(302, { location: `https://b.test:${ports.b}/after-redirect` });
      res.end();
      return;
    }
    if (url === "/pixel") {
      // Content is irrelevant (design says "content doesn't matter"); only
      // the request's own headers are asserted on.
      res.writeHead(200, { "content-type": "image/gif" });
      res.end("not-a-real-gif");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const serverB = https.createServer({ cert, key }, (req, res) => {
    const url = req.url ?? "";
    recordedB.push({ path: url, headers: req.headers });
    if (url === "/doc") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>b.test doc</title><h1>b.test doc</h1>");
      return;
    }
    if (url === "/after-redirect") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (url === "/img-page") {
      // A cross-origin <img> back at a.test: the initiator (b.test) does not
      // match the rule's host, even though the REQUEST url is an exact match.
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>b.test img page</title><img src="https://a.test:${ports.a}/pixel">`);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  ports.a = await listenHttps(serverA);
  ports.b = await listenHttps(serverB);

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-header-rules-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-header-rules-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );

  const app = await electron.launch({
    args: [
      repoRoot,
      `--user-data-dir=${userDataDir}`,
      "--ignore-certificate-errors",
      "--host-resolver-rules=MAP a.test 127.0.0.1,MAP b.test 127.0.0.1",
    ],
    cwd: repoRoot,
  });
  const page = await app.firstWindow();

  try {
    await expect(page.locator(".workspace")).toBeVisible();

    // ---- Fast path: a declined add() persists nothing (design §5.6) -------
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    const declined = await page.evaluate(() =>
      (window as unknown as GeodeTestWindow).geode.browserHeaderRules!.add({
        host: "declined-test.example",
        header: "x-declined-test",
        secretId: "ct-secret-declined-test",
        createdBy: "agent",
      }),
    );
    expect(declined).toEqual({ success: false, status: "declined" });
    const listAfterDecline = await page.evaluate(() =>
      (window as unknown as GeodeTestWindow).geode.browserHeaderRules!.list(),
    );
    expect(listAfterDecline.some((rule) => rule.host === "declined-test.example")).toBe(false);

    // ---- Approve the real rule: a.test, one header, one secret -----------
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.evaluate(
      (args) => (window as unknown as GeodeTestWindow).geode.setSecret!(args.id, args.value),
      { id: PROBE_SECRET_ID, value: PROBE_SECRET_VALUE },
    );
    const added = await page.evaluate(
      (args) =>
        (window as unknown as GeodeTestWindow).geode.browserHeaderRules!.add({
          host: args.host,
          header: args.header,
          secretId: args.secretId,
          port: args.port,
          createdBy: "agent",
          ttlMs: 60 * 60 * 1000,
          requester: args.requester,
        }),
      { host: "a.test", header: PROBE_HEADER, secretId: PROBE_SECRET_ID, port: ports.a, requester: "e2e header-rules test" },
    );
    if (!added.success) throw new Error(`Expected rule creation to succeed, got ${JSON.stringify(added)}`);
    const ruleId = added.ruleId;

    // ---- 7. list() never contains the value, checked right after add() ---
    const listAfterAdd = await page.evaluate(() =>
      (window as unknown as GeodeTestWindow).geode.browserHeaderRules!.list(),
    );
    expect(JSON.stringify(listAfterAdd)).not.toContain(PROBE_SECRET_VALUE);

    // ---- Create the guest and navigate it to a.test/doc --------------------
    // Same partition-creation pattern as webview-client-hints.spec.ts. The
    // reference stores its own view directly; this one stashes it on
    // `window` so later steps in this spec can drive further navigations on
    // the SAME guest via `navigate()` below.
    await page.evaluate((docUrl) => {
      return new Promise<void>((resolve, reject) => {
        const view = document.createElement("webview") as GuestWebview;
        view.setAttribute("partition", "persist:agent-browser");
        view.setAttribute("src", docUrl);
        view.setAttribute("style", "position:absolute;left:-9999px;width:800px;height:600px");
        view.addEventListener(
          "did-finish-load",
          () => {
            (window as unknown as Record<string, unknown>).__headerRulesGuest = view;
            resolve();
          },
          { once: true },
        );
        view.addEventListener("did-fail-load", () => reject(new Error("initial guest load failed")), { once: true });
        setTimeout(() => reject(new Error("initial guest load timed out")), 20_000);
        document.body.appendChild(view);
      });
    }, `https://a.test:${ports.a}/doc`);

    await expect.poll(() => recordedA.some((r) => r.path === "/xhr"), { timeout: 20_000 }).toBe(true);

    // ---- 1. doc + same-host subresource carry the header -------------------
    const docRequest1 = recordedA.find((r) => r.path === "/doc")!;
    const xhrRequest1 = recordedA.find((r) => r.path === "/xhr")!;
    expect(docRequest1.headers[PROBE_HEADER]).toBe(PROBE_SECRET_VALUE);
    expect(xhrRequest1.headers[PROBE_HEADER]).toBe(PROBE_SECRET_VALUE);

    // Drives the SAME guest to a new top-level URL and waits for it to finish
    // loading, mirroring `loadOnce()` in webview-client-hints.spec.ts.
    const navigate = (url: string) =>
      page.evaluate((targetUrl) => {
        return new Promise<void>((resolve, reject) => {
          const view = (window as unknown as Record<string, unknown>).__headerRulesGuest as GuestWebview;
          const onLoad = () => {
            view.removeEventListener("did-finish-load", onLoad);
            resolve();
          };
          const onFail = () => {
            view.removeEventListener("did-fail-load", onFail);
            reject(new Error(`guest navigation failed: ${targetUrl}`));
          };
          view.addEventListener("did-finish-load", onLoad, { once: true });
          view.addEventListener("did-fail-load", onFail, { once: true });
          setTimeout(() => reject(new Error(`guest navigation timed out: ${targetUrl}`)), 20_000);
          void view.loadURL(targetUrl);
        });
      }, url);

    // ---- 2. b.test/doc: no rule matches it, so nothing is sent ------------
    await navigate(`https://b.test:${ports.b}/doc`);

    // ---- 3. redirect leg behavior (design §12's concrete UNVERIFIED item) -
    await navigate(`https://a.test:${ports.a}/redirect-to-b`);
    await expect.poll(() => recordedB.some((r) => r.path === "/after-redirect"), { timeout: 20_000 }).toBe(true);
    const redirectLeg1 = recordedA.find((r) => r.path === "/redirect-to-b")!;
    const redirectLeg2 = recordedB.find((r) => r.path === "/after-redirect")!;
    expect(redirectLeg1.headers[PROBE_HEADER]).toBe(PROBE_SECRET_VALUE);
    // This assertion alone cannot distinguish "Chromium never carried the
    // header across the cross-origin redirect" from "it was carried and the
    // scrub stage (browser-header-rules.ts's `scrubMatchedSecretValue`, wired
    // in main.ts's second pipeline stage) removed it" — both are correct
    // behavior from the outside, and design §5.2's own rationale for the
    // scrub stage is explicitly a defence-in-depth backstop ("in case
    // Chromium carries extra headers across a redirect"), not a claim about
    // which of the two actually happens. See the report for which one this
    // run's evidence points to.
    expect(redirectLeg2.headers[PROBE_HEADER]).toBeUndefined();

    // ---- 4. initiator gate: a cross-origin subresource is denied ----------
    await navigate(`https://b.test:${ports.b}/img-page`);
    await expect.poll(() => recordedA.some((r) => r.path === "/pixel"), { timeout: 20_000 }).toBe(true);
    const pixelRequest = recordedA.find((r) => r.path === "/pixel")!;
    expect(pixelRequest.headers[PROBE_HEADER]).toBeUndefined();

    // ---- 2 (full check): b.test NEVER receives the header, on any request -
    for (const record of recordedB) {
      expect(record.headers[PROBE_HEADER], `${PROBE_HEADER} leaked to b.test${record.path}`).toBeUndefined();
    }

    // ---- 6. low-entropy client hints still present (regression guard) -----
    // Proves the rule/scrub stages compose with the existing client-hint
    // stage on the one shared onBeforeSendHeaders pipeline rather than
    // replacing it (guest-request-pipeline.ts).
    for (const record of [...recordedA, ...recordedB]) {
      for (const hint of LOW_ENTROPY_CLIENT_HINTS) {
        expect(record.headers[hint], `${hint} missing on ${record.path}`).toBeTruthy();
      }
    }

    // ---- 8. after remove(), a repeat navigation carries nothing -----------
    const removed = await page.evaluate(
      (id) => (window as unknown as GeodeTestWindow).geode.browserHeaderRules!.remove(id),
      ruleId,
    );
    expect(removed).toBe(true);
    const docCountBeforeRemoval = recordedA.filter((r) => r.path === "/doc").length;
    await navigate(`https://a.test:${ports.a}/doc`);
    await expect
      .poll(() => recordedA.filter((r) => r.path === "/doc").length > docCountBeforeRemoval, { timeout: 20_000 })
      .toBe(true);
    const docRequestsAfterRemoval = recordedA.filter((r) => r.path === "/doc");
    const latestDocRequest = docRequestsAfterRemoval[docRequestsAfterRemoval.length - 1];
    expect(latestDocRequest.headers[PROBE_HEADER]).toBeUndefined();

    // list() still never contains the value, even after the full lifecycle.
    const listAtEnd = await page.evaluate(() =>
      (window as unknown as GeodeTestWindow).geode.browserHeaderRules!.list(),
    );
    expect(JSON.stringify(listAtEnd)).not.toContain(PROBE_SECRET_VALUE);
  } finally {
    await app.close();
    await Promise.all([
      new Promise<void>((resolve) => serverA.close(() => resolve())),
      new Promise<void>((resolve) => serverB.close(() => resolve())),
    ]);
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(certDir, { recursive: true, force: true });
  }
});
