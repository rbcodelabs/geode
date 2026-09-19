import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * Webview guests must present as authentic stock Chromium, self-consistently.
 *
 * Geode's guests were rejected by bot-detection systems because the default
 * Electron user-agent names the embedder: united.com answered
 * ERR_HTTP2_PROTOCOL_ERROR, a refusal at the protocol level rather than a
 * challenge page. A/B on the live site against the same build isolated it to
 * that one token. See src/main/guest-fingerprint.ts.
 *
 * Two invariants are pinned here, and the second is the subtle one:
 *
 *   1. No embedder token (`Electron/`, `geode/`) in the UA — not in the request
 *      header, not in `navigator.userAgent`, not in `navigator.appVersion`.
 *   2. The `Sec-CH-UA` header matches `navigator.userAgentData.brands` EXACTLY.
 *      `brands` cannot be overridden from the host by any lever, so a header
 *      claiming a brand Chromium does not report would make the fingerprint
 *      self-contradictory — which scores worse with detectors than an
 *      unusual-but-coherent one. This assertion is also what catches a future
 *      Chromium changing its GREASE brand out from under the derived header.
 *
 * Both are checked on a NON-DEFAULT partition created at runtime
 * (`persist:agent-browser`, the Agent Browser's), because the client hints are
 * installed via `app.on("session-created")` specifically to reach partitions
 * that do not exist at startup, and because `session.fromPartition(p)
 * .setUserAgent(...)` was measured to silently do nothing.
 *
 * Served over loopback HTTP rather than a public origin so the suite stays
 * offline and deterministic. `127.0.0.1` is a potentially-trustworthy origin, so
 * `navigator.userAgentData` is still exposed.
 */

const repoRoot = path.resolve(__dirname, "..", "..");

type Recorded = { path: string; headers: http.IncomingHttpHeaders };

test("webview guests present as stock Chromium with matching client hints", async () => {
  const recorded: Recorded[] = [];
  const server = http.createServer((req, res) => {
    recorded.push({ path: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "text/html" });
    // The title doubles as a load signal for the Web Viewer poll below.
    res.end("<!doctype html><title>fingerprint probe</title><h1>fingerprint probe</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-fingerprint-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-fingerprint-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();

  try {
    await expect(window.locator(".workspace")).toBeVisible();

    // --- The Agent Browser surface: a plugin-style guest on a partition that
    // did not exist when the app started. -----------------------------------
    const guest = await window.evaluate(
      async ([url]) => {
        const view = document.createElement("webview") as HTMLElement & {
          executeJavaScript(code: string): Promise<unknown>;
        };
        view.setAttribute("partition", "persist:agent-browser");
        view.setAttribute("src", url);
        view.setAttribute("style", "position:absolute;left:-9999px;width:800px;height:600px");
        const loaded = new Promise<void>((resolve, reject) => {
          view.addEventListener("did-finish-load", () => resolve(), { once: true });
          view.addEventListener("did-fail-load", () => reject(new Error("guest failed to load")), { once: true });
          setTimeout(() => reject(new Error("guest load timed out")), 20_000);
        });
        document.body.appendChild(view);
        await loaded;
        return view.executeJavaScript(`(() => ({
          userAgent: navigator.userAgent,
          appVersion: navigator.appVersion,
          brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
          mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
          platform: navigator.userAgentData ? navigator.userAgentData.platform : null,
        }))()`);
      },
      [`${origin}/agent-browser`],
    ) as {
      userAgent: string;
      appVersion: string;
      brands: { brand: string; version: string }[] | null;
      mobile: boolean | null;
      platform: string | null;
    };

    const agentRequest = recorded.find((r) => r.path === "/agent-browser");
    expect(agentRequest, "the guest request never reached the test server").toBeTruthy();
    const headers = agentRequest!.headers;

    // 1. No embedder token anywhere the page can see it.
    const uaHeader = headers["user-agent"] ?? "";
    for (const [label, value] of [
      ["User-Agent header", uaHeader],
      ["navigator.userAgent", guest.userAgent],
      ["navigator.appVersion", guest.appVersion],
    ] as const) {
      expect(value, `${label} must not name Electron`).not.toMatch(/Electron\//i);
      expect(value, `${label} must not name Geode`).not.toMatch(/geode\//i);
    }
    // Still claims the engine it really is — the fix removes the embedder, it
    // does not pretend to be a different browser.
    expect(uaHeader).toMatch(/Chrome\/\d+\./);
    expect(uaHeader).toMatch(/Safari\/537\.36$/);
    // The header and the JS surface are the same string.
    expect(guest.userAgent).toBe(uaHeader);

    // 2. All three client hints present — Electron natively sends none.
    expect(headers["sec-ch-ua"], "Sec-CH-UA missing").toBeTruthy();
    expect(headers["sec-ch-ua-mobile"]).toBe("?0");
    expect(headers["sec-ch-ua-platform"]).toBeTruthy();

    // ...and Sec-CH-UA matches navigator.userAgentData.brands exactly.
    expect(guest.brands, "navigator.userAgentData.brands unavailable").toBeTruthy();
    const expectedSecChUa = guest
      .brands!.map((b) => `"${b.brand}";v="${b.version}"`)
      .join(", ");
    expect(headers["sec-ch-ua"]).toBe(expectedSecChUa);
    // No forged brand: brands cannot be overridden from the host, so claiming
    // "Google Chrome" in the header would contradict the JS surface.
    expect(headers["sec-ch-ua"]).not.toContain("Google Chrome");

    // The other two hints agree with their JS counterparts too.
    expect(headers["sec-ch-ua-mobile"]).toBe(guest.mobile ? "?1" : "?0");
    expect(headers["sec-ch-ua-platform"]).toBe(`"${guest.platform}"`);

    // --- The shipped Web Viewer surface, opened the way a user would. -------
    await window.evaluate(
      (url) => (window as unknown as { app: { openWebViewer(u: string): unknown } }).app.openWebViewer(url),
      `${origin}/web-viewer`,
    );
    await expect
      .poll(() => recorded.some((r) => r.path === "/web-viewer"), { timeout: 20_000 })
      .toBe(true);
    const viewerHeaders = recorded.find((r) => r.path === "/web-viewer")!.headers;
    expect(viewerHeaders["user-agent"]).not.toMatch(/Electron\//i);
    expect(viewerHeaders["user-agent"]).not.toMatch(/geode\//i);
    expect(viewerHeaders["sec-ch-ua"]).toBe(expectedSecChUa);
    expect(viewerHeaders["sec-ch-ua-mobile"]).toBe("?0");
    expect(viewerHeaders["sec-ch-ua-platform"]).toBe(`"${guest.platform}"`);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
