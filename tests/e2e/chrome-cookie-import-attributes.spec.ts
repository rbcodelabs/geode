import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { chromeCookieToSetDetails } from "../../src/main/chrome-cookies";

/**
 * The Chrome cookie importer writes into a real Chromium cookie store, and
 * Chromium — not our code — is the authority on which cookies it will accept.
 * These assertions therefore run against `persist:webviewer` inside a launched
 * Geode main process, not against a stub.
 *
 * The bug this pins: Gmail in the Web Viewer reported "We've detected a problem
 * with your cookie settings" while google.com looked signed in. Chrome's jar
 * held 11 cookies for mail.google.com; Geode's held 2. Three separate defects
 * in src/main/chrome-cookies.ts produced that gap, and all three are observable
 * here through what the store gives back:
 *
 *   1. `domain` was passed unconditionally, so every `__Host-`-prefixed cookie
 *      was rejected outright — Chromium forbids a Domain attribute on them.
 *      This is the headline fix and the first test is its regression guard: it
 *      sets the SAME cookie twice, once with a Domain and once via
 *      chromeCookieToSetDetails, and asserts Chromium refuses the first and
 *      accepts the second. Reverting the fix makes the second call fail.
 *   2. `is_httponly` and `samesite` were never selected from Chrome's DB, so
 *      both attributes were silently dropped. A `SameSite=None` cookie that
 *      arrives as Lax is never sent cross-site, which is what Gmail needs.
 *   3. Cookies with no expiry are session cookies, which Electron holds in
 *      memory only. Asserted, not fixed — Electron gives no way to persist
 *      them, so the import UI says so instead.
 *
 * Every cookie value here is synthetic and every host is under example.com.
 * Nothing touches the network: `cookies.set` only parses the URL.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const WEBVIEWER_PARTITION = "persist:webviewer";

/** A far-future but safely-in-range expiry, in Chrome's epoch (µs since 1601-01-01). */
const PERSISTENT_EXPIRY_UTC = (1_900_000_000 + 11644473600) * 1_000_000;

type SetOutcome = { ok: boolean; error: string | null };
type StoredCookie = {
  name: string;
  domain?: string;
  hostOnly?: boolean;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite: string;
  path?: string;
  session?: boolean;
};

/**
 * Run `details` through the real cookie store in the main process. Each entry
 * is attempted independently and its acceptance or rejection recorded, then the
 * whole store is read back.
 */
async function setInWebViewerJar(
  app: Awaited<ReturnType<typeof electron.launch>>,
  details: Electron.CookiesSetDetails[],
): Promise<{ outcomes: SetOutcome[]; stored: StoredCookie[] }> {
  return app.evaluate(async ({ session }, { partition, batch }) => {
    const jar = session.fromPartition(partition).cookies;
    const outcomes: SetOutcome[] = [];
    for (const d of batch) {
      try {
        await jar.set(d);
        outcomes.push({ ok: true, error: null });
      } catch (err) {
        outcomes.push({ ok: false, error: (err as Error).message ?? String(err) });
      }
    }
    const stored = (await jar.get({})).map((c) => ({
      name: c.name,
      domain: c.domain,
      hostOnly: c.hostOnly,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      path: c.path,
      session: c.session,
    }));
    return { outcomes, stored };
  }, { partition: WEBVIEWER_PARTITION, batch: details });
}

function launchGeode() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-cookie-import-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-cookie-import-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );
  return {
    vaultDir,
    userDataDir,
    app: electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot }),
  };
}

test("a __Host- cookie imports only when no Domain attribute is sent (defect 1)", async () => {
  const { vaultDir, userDataDir, app: launching } = launchGeode();
  const app = await launching;
  try {
    const row = {
      host_key: "mail.geode-probe.example.com", // no leading dot: host-only in Chrome
      name: "__Host-GEODE_PROBE_SCH",
      path: "/",
      is_secure: 1,
      expires_utc: PERSISTENT_EXPIRY_UTC,
      is_httponly: 1,
      samesite: 1,
    };

    const fixed = chromeCookieToSetDetails(row, "synthetic-host-prefixed-value");
    // What the importer used to send: identical, plus the Domain attribute that
    // line 244 passed unconditionally. Renamed so the two attempts cannot
    // overwrite each other, but still `__Host-`-prefixed.
    const preFix: Electron.CookiesSetDetails = {
      ...fixed,
      name: "__Host-GEODE_PROBE_SCH_WITH_DOMAIN",
      domain: row.host_key,
    };

    expect(preFix.domain).toBe("mail.geode-probe.example.com");

    const { outcomes, stored } = await setInWebViewerJar(app, [preFix, fixed]);
    const [preFixOutcome, fixedOutcome] = outcomes;

    // Chromium's own verdict comes first, deliberately: if the `domain`
    // omission is reverted, this is the assertion that fails, and it fails with
    // the real rejection message rather than with a shape mismatch.
    expect(fixedOutcome.ok, `__Host- cookie was rejected: ${fixedOutcome.error}`).toBe(true);
    expect(fixedOutcome.error).toBeNull();

    // The old shape is rejected by Chromium itself.
    expect(
      preFixOutcome.ok,
      "a __Host- cookie carrying a Domain attribute should be rejected; if this passes, " +
        "Chromium relaxed the prefix rule and this whole guard needs rethinking",
    ).toBe(false);
    expect(preFixOutcome.error).toMatch(/__Host-|__Secure-/);

    // The fix is precisely the absence of this field.
    expect(fixed).not.toHaveProperty("domain");

    // Present in the store, host-only, and the rejected variant absent.
    const names = stored.map((c) => c.name);
    expect(names).toContain("__Host-GEODE_PROBE_SCH");
    expect(names).not.toContain("__Host-GEODE_PROBE_SCH_WITH_DOMAIN");

    const cookie = stored.find((c) => c.name === "__Host-GEODE_PROBE_SCH")!;
    // hostOnly is true only when no domain was passed — Chromium confirming the fix.
    expect(cookie.hostOnly).toBe(true);
    expect(cookie.domain).toBe("mail.geode-probe.example.com");
    expect(cookie.secure).toBe(true);
    expect(cookie.path).toBe("/");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("httpOnly and SameSite survive the round trip into the real store (defect 2)", async () => {
  const { vaultDir, userDataDir, app: launching } = launchGeode();
  const app = await launching;
  try {
    // A secure domain cookie with SameSite=None (Chrome's samesite = 0) — the
    // shape __Secure-3PSID and NID have, and the one Gmail depends on being
    // sent cross-site. Dropping the attribute made it Lax and therefore unsent.
    const crossSite = chromeCookieToSetDetails(
      {
        host_key: ".geode-probe.example.com", // leading dot: domain cookie
        name: "__Secure-GEODE_PROBE_3P",
        path: "/",
        is_secure: 1,
        expires_utc: PERSISTENT_EXPIRY_UTC,
        is_httponly: 1,
        samesite: 0,
      },
      "synthetic-cross-site-value",
    );
    const strict = chromeCookieToSetDetails(
      {
        host_key: "geode-probe.example.com",
        name: "GEODE_PROBE_STRICT",
        path: "/",
        is_secure: 1,
        expires_utc: PERSISTENT_EXPIRY_UTC,
        is_httponly: 0,
        samesite: 2,
      },
      "synthetic-strict-value",
    );

    const { outcomes, stored } = await setInWebViewerJar(app, [crossSite, strict]);
    expect(outcomes.every((o) => o.ok), JSON.stringify(outcomes)).toBe(true);

    const threeP = stored.find((c) => c.name === "__Secure-GEODE_PROBE_3P")!;
    expect(threeP.sameSite).toBe("no_restriction");
    expect(threeP.httpOnly).toBe(true);
    expect(threeP.secure).toBe(true);
    // A domain cookie: not host-only, dot-prefixed so it covers subdomains.
    expect(threeP.hostOnly).toBe(false);
    expect(threeP.domain).toBe(".geode-probe.example.com");

    const strictStored = stored.find((c) => c.name === "GEODE_PROBE_STRICT")!;
    expect(strictStored.sameSite).toBe("strict");
    expect(strictStored.httpOnly).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("a cookie with no expiry is stored as a session cookie and is gone after a restart (defect 3)", async () => {
  // Two launches share one userDataDir so the second sees whatever the first
  // actually persisted. The claim under test is narrow and only about restart
  // survival: the on-disk jar structurally cannot hold session cookies, so its
  // contents alone prove nothing about whether any were imported.
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-cookie-session-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-cookie-session-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );
  const launch = () =>
    electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });

  // expires_utc = 0 is how Chrome records a session cookie (GMAIL_AT and
  // __Host-GMAIL_SCH are both this shape), and the mapper omits expirationDate.
  const sessionCookie = chromeCookieToSetDetails(
    {
      host_key: "geode-probe.example.com",
      name: "GEODE_PROBE_SESSION",
      path: "/",
      is_secure: 1,
      expires_utc: 0,
      is_httponly: 1,
      samesite: 1,
    },
    "synthetic-session-value",
  );
  const persistentCookie = chromeCookieToSetDetails(
    {
      host_key: "geode-probe.example.com",
      name: "GEODE_PROBE_PERSISTENT",
      path: "/",
      is_secure: 1,
      expires_utc: PERSISTENT_EXPIRY_UTC,
      is_httponly: 1,
      samesite: 1,
    },
    "synthetic-persistent-value",
  );
  expect(sessionCookie).not.toHaveProperty("expirationDate");
  expect(persistentCookie.expirationDate).toBeGreaterThan(Date.now() / 1000);

  const first = await launch();
  try {
    const { outcomes, stored } = await setInWebViewerJar(first, [sessionCookie, persistentCookie]);
    expect(outcomes.every((o) => o.ok), JSON.stringify(outcomes)).toBe(true);

    // Both are in the live store, and Electron labels the expiry-less one a
    // session cookie. That label is the whole problem: session cookies live in
    // memory and are never written to disk.
    expect(stored.find((c) => c.name === "GEODE_PROBE_SESSION")!.session).toBe(true);
    expect(stored.find((c) => c.name === "GEODE_PROBE_PERSISTENT")!.session).toBe(false);

    // flushStore is what the importer calls, so this rules out "it just wasn't
    // flushed yet" as the explanation for the disappearance below.
    await first.evaluate(
      ({ session }, partition) => session.fromPartition(partition).cookies.flushStore(),
      WEBVIEWER_PARTITION,
    );
  } finally {
    await first.close();
  }

  const second = await launch();
  try {
    const survivors = await second.evaluate(
      async ({ session }, partition) =>
        (await session.fromPartition(partition).cookies.get({})).map((c) => c.name),
      WEBVIEWER_PARTITION,
    );
    // The defensible statement, and the one the import UI now makes to the user.
    expect(survivors).toContain("GEODE_PROBE_PERSISTENT");
    expect(survivors).not.toContain("GEODE_PROBE_SESSION");
  } finally {
    await second.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
