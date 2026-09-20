import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * Per-origin high-entropy client-hint negotiation, end to end in a real guest.
 *
 * Electron implements no client-hint negotiation: real Chrome remembers the
 * `Accept-CH` an origin sent and supplies those high-entropy hints on later
 * requests to it, and Geode supplied none. See src/main/guest-fingerprint.ts.
 *
 * Four invariants are pinned, against two DISTINCT loopback origins so that
 * "per-origin" is actually exercised rather than assumed:
 *
 *   1. An origin that sent `Accept-CH` receives the hints it asked for.
 *   2. An origin that sent no `Accept-CH` receives NONE of them. This is the
 *      privacy half: high-entropy hints must never be broadcast.
 *   3. A hint an origin disables via `Permissions-Policy: ch-ua-arch=()` is
 *      withheld from that origin's SUBRESOURCES but still sent on its
 *      navigations. That split is measured real-Chrome behavior, not a guess —
 *      a blanket intersection would withhold arch from the document request,
 *      which real Chrome sends.
 *   4. The three LOW-entropy hints from PR #248 are still present on every
 *      request. Electron permits only one `onBeforeSendHeaders` listener per
 *      session and silently replaces it, so negotiation extending that listener
 *      rather than adding a second is load-bearing; this is the regression guard.
 *
 * Every asserted value is additionally compared against the guest's own
 * `navigator.userAgentData.getHighEntropyValues()`. Those cannot be overridden
 * from the host, so that comparison is what keeps the headers from contradicting
 * the JS surface as Chromium versions move.
 *
 * Served over loopback HTTP rather than a public origin so the suite stays
 * offline and deterministic. `127.0.0.1` is a potentially-trustworthy origin, so
 * `navigator.userAgentData` is still exposed.
 */

const repoRoot = path.resolve(__dirname, "..", "..");

/** Everything united.com's real Accept-CH asks for, minus the low-entropy one. */
const ACCEPT_CH =
  "Sec-CH-UA-Arch,Sec-CH-UA-Bitness,Sec-CH-UA-Full-Version,Sec-CH-UA-Full-Version-List," +
  "Sec-CH-UA-Model,Sec-CH-UA-Platform,Sec-CH-UA-Platform-Version,Sec-CH-UA-WoW64";

/** The shape of united.com's real policy: asks for arch/bitness, disables both. */
const PERMISSIONS_POLICY = "ch-ua-arch=(), ch-ua-bitness=(), ch-dpr=()";

const LOW_ENTROPY = ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"] as const;
const HIGH_ENTROPY = [
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-model",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-wow64",
] as const;

type Recorded = { path: string; headers: http.IncomingHttpHeaders };

/**
 * A loopback origin. `asks` decides whether its responses carry `Accept-CH` —
 * the only difference between the two servers, so any divergence in the hints
 * they receive is attributable to negotiation and nothing else.
 */
function createOrigin(asks: boolean) {
  const recorded: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    recorded.push({ path: url, headers: req.headers });
    const isDocument = url === "/prime" || url === "/doc";
    res.writeHead(200, {
      "content-type": isDocument ? "text/html" : "text/plain",
      ...(asks ? { "accept-ch": ACCEPT_CH, "permissions-policy": PERMISSIONS_POLICY } : {}),
    });
    if (url === "/doc") {
      // The subresource case: an XHR back to this same origin, which is where a
      // Permissions-Policy disable actually bites.
      res.end(
        "<!doctype html><title>client hints probe</title><h1>client hints probe</h1>" +
          "<script>fetch('/xhr');</script>",
      );
      return;
    }
    res.end(isDocument ? "<!doctype html><title>prime</title>" : "ok");
  });
  return { server, recorded };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("high-entropy client hints are negotiated per origin", async () => {
  const asks = createOrigin(true);
  const quiet = createOrigin(false);
  const asksOrigin = await listen(asks.server);
  const quietOrigin = await listen(quiet.server);

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hints-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-hints-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();

  try {
    await expect(window.locator(".workspace")).toBeVisible();

    // A guest on a partition that did not exist at startup — the Agent Browser's.
    // Negotiation is installed via `session-created`, so this is the surface that
    // proves it reaches late partitions.
    const guest = (await window.evaluate(
      async ([primeUrl, docUrl]) => {
        const view = document.createElement("webview") as HTMLElement & {
          executeJavaScript(code: string): Promise<unknown>;
          loadURL(url: string): Promise<void>;
        };
        view.setAttribute("partition", "persist:agent-browser");
        view.setAttribute("src", primeUrl);
        view.setAttribute("style", "position:absolute;left:-9999px;width:800px;height:600px");

        const loadOnce = () =>
          new Promise<void>((resolve, reject) => {
            view.addEventListener("did-finish-load", () => resolve(), { once: true });
            view.addEventListener("did-fail-load", () => reject(new Error("guest failed to load")), { once: true });
            setTimeout(() => reject(new Error("guest load timed out")), 20_000);
          });

        const primed = loadOnce();
        document.body.appendChild(view);
        await primed;

        // Second navigation to the SAME origin: by now Accept-CH has been seen,
        // so this request is the one that must carry the hints.
        const navigated = loadOnce();
        await view.loadURL(docUrl);
        await navigated;

        return view.executeJavaScript(`(async () => {
          const uad = navigator.userAgentData;
          if (!uad) return null;
          return {
            brands: uad.brands,
            high: await uad.getHighEntropyValues([
              "architecture","bitness","model","platformVersion","uaFullVersion","fullVersionList","wow64",
            ]),
          };
        })()`);
      },
      [`${asksOrigin}/prime`, `${asksOrigin}/doc`],
    )) as {
      brands: { brand: string; version: string }[];
      high: {
        architecture: string;
        bitness: string;
        model: string;
        platformVersion: string;
        uaFullVersion: string;
        fullVersionList: { brand: string; version: string }[];
        wow64: boolean;
      };
    } | null;

    expect(guest, "navigator.userAgentData unavailable in the guest").toBeTruthy();
    await expect.poll(() => asks.recorded.some((r) => r.path === "/xhr"), { timeout: 20_000 }).toBe(true);

    // ---- 1 + 3: the origin that asked ------------------------------------
    const asksNav = asks.recorded.find((r) => r.path === "/doc")!.headers;
    const asksXhr = asks.recorded.find((r) => r.path === "/xhr")!.headers;

    // Values agree with what this guest's own Chromium reports. Anything else
    // would make the headers contradict the unoverridable JS surface.
    const { high } = guest!;
    expect(asksNav["sec-ch-ua-full-version"]).toBe(`"${high.uaFullVersion}"`);
    expect(asksNav["sec-ch-ua-full-version-list"]).toBe(
      high.fullVersionList.map((b) => `"${b.brand}";v="${b.version}"`).join(", "),
    );
    expect(asksNav["sec-ch-ua-model"]).toBe(`"${high.model}"`);
    expect(asksNav["sec-ch-ua-platform-version"]).toBe(`"${high.platformVersion}"`);
    expect(asksNav["sec-ch-ua-wow64"]).toBe(high.wow64 ? "?1" : "?0");
    // Arch and bitness ride the NAVIGATION even though the policy disables them.
    expect(asksNav["sec-ch-ua-arch"]).toBe(`"${high.architecture}"`);
    expect(asksNav["sec-ch-ua-bitness"]).toBe(`"${high.bitness}"`);

    // The subresource is where the Permissions-Policy disable takes effect.
    expect(asksXhr["sec-ch-ua-arch"], "ch-ua-arch=() must withhold arch from a subresource").toBeUndefined();
    expect(asksXhr["sec-ch-ua-bitness"], "ch-ua-bitness=() must withhold bitness").toBeUndefined();
    // Everything else the origin asked for still goes on the subresource.
    expect(asksXhr["sec-ch-ua-full-version"]).toBe(`"${high.uaFullVersion}"`);
    expect(asksXhr["sec-ch-ua-platform-version"]).toBe(`"${high.platformVersion}"`);
    expect(asksXhr["sec-ch-ua-model"]).toBe(`"${high.model}"`);
    expect(asksXhr["sec-ch-ua-wow64"]).toBe(high.wow64 ? "?1" : "?0");

    // ---- 2: the origin that did not ask ----------------------------------
    await window.evaluate(
      (url) => (window as unknown as { app: { openWebViewer(u: string): unknown } }).app.openWebViewer(url),
      `${quietOrigin}/doc`,
    );
    await expect.poll(() => quiet.recorded.some((r) => r.path === "/xhr"), { timeout: 20_000 }).toBe(true);

    for (const record of quiet.recorded) {
      for (const hint of HIGH_ENTROPY) {
        expect(
          record.headers[hint],
          `${hint} leaked to ${record.path}, an origin that never sent Accept-CH`,
        ).toBeUndefined();
      }
    }

    // ---- 4: PR #248's low-entropy hints survive on every request ---------
    const everyRequest = [...asks.recorded, ...quiet.recorded];
    expect(everyRequest.length).toBeGreaterThan(3);
    for (const record of everyRequest) {
      for (const hint of LOW_ENTROPY) {
        expect(record.headers[hint], `${hint} missing on ${record.path}`).toBeTruthy();
      }
      expect(record.headers["sec-ch-ua-mobile"]).toBe("?0");
      // And the UA is still stripped of both embedder tokens.
      expect(record.headers["user-agent"]).not.toMatch(/Electron\//i);
      expect(record.headers["user-agent"]).not.toMatch(/geode\//i);
    }
    // Sec-CH-UA still matches the guest's brands exactly.
    const expectedSecChUa = guest!.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(", ");
    for (const record of everyRequest) {
      expect(record.headers["sec-ch-ua"]).toBe(expectedSecChUa);
    }
  } finally {
    await app.close();
    await new Promise<void>((resolve) => asks.server.close(() => resolve()));
    await new Promise<void>((resolve) => quiet.server.close(() => resolve()));
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
