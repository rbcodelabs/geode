import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyRuleHeader,
  createHeaderRule,
  DEFAULT_AGENT_TTL_MS,
  HeaderRule,
  HeaderRuleStore,
  HeaderRuleValidationError,
  isHeaderAllowedForCreator,
  isRuleExpired,
  isValidHeaderValue,
  MatchableRequest,
  matchRule,
  MAX_AGENT_TTL_MS,
  pruneExpiredRules,
  requiresStrongWarning,
  scrubMatchedSecretValue,
} from "../../src/main/browser-header-rules";

/**
 * `matchRule` is the security-load-bearing part of this feature (design
 * §5.2): everything below is drawn from the design note's threat model and
 * §9 testing plan, since a matcher bug here means a secret goes somewhere
 * it shouldn't. `HeaderRuleStore` mirrors `secret-store.test.ts`'s style —
 * a temp-dir-backed file, round-tripped across process instances.
 */

const BASE_RULE: HeaderRule = {
  id: "rule-1",
  host: "foo.vercel.app",
  header: "x-vercel-protection-bypass",
  secretId: "ct-secret-rbcodelabs-vercel-bypass",
  surfaces: ["agent-browser"],
  createdBy: "agent",
  createdAt: "2026-09-28T00:00:00.000Z",
  approvedAt: "2026-09-28T00:00:00.000Z",
  // Deliberately far in the future: HeaderRuleStore tests exercise real
  // wall-clock `now` (no `now` override), so a near-term default here would
  // make this rule spuriously prune itself out as the test suite ages.
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function rule(overrides: Partial<HeaderRule> = {}): HeaderRule {
  return { ...BASE_RULE, ...overrides };
}

function req(overrides: Partial<MatchableRequest> = {}): MatchableRequest {
  return { url: "https://foo.vercel.app/", resourceType: "mainFrame", initiatorUrl: null, ...overrides };
}

describe("matchRule", () => {
  describe("host/port/protocol matcher table", () => {
    it("matches an exact host over https on the default port", () => {
      expect(matchRule(rule(), req({ url: "https://foo.vercel.app/page" }))).toBe(true);
    });

    it("is case-insensitive on the host", () => {
      expect(matchRule(rule(), req({ url: "https://FOO.VERCEL.APP/" }))).toBe(true);
    });

    it("strips a trailing dot before comparing", () => {
      expect(matchRule(rule(), req({ url: "https://foo.vercel.app./" }))).toBe(true);
    });

    it("matches a punycode-normalized IDN host", () => {
      expect(matchRule(rule({ host: "xn--mller-kva.example" }), req({ url: "https://müller.example/" }))).toBe(
        true,
      );
    });

    it("uses port 443 by default and rejects an explicit mismatched port", () => {
      expect(matchRule(rule(), req({ url: "https://foo.vercel.app:443/" }))).toBe(true);
      expect(matchRule(rule(), req({ url: "https://foo.vercel.app:8443/" }))).toBe(false);
    });

    it("matches an explicit port when the rule specifies one", () => {
      expect(matchRule(rule({ port: 8443 }), req({ url: "https://foo.vercel.app:8443/" }))).toBe(true);
      expect(matchRule(rule({ port: 8443 }), req({ url: "https://foo.vercel.app/" }))).toBe(false);
    });

    it("rejects http:// when the host is not loopback-excepted", () => {
      expect(matchRule(rule(), req({ url: "http://foo.vercel.app/" }))).toBe(false);
    });

    it("rejects an IP-literal host even over https", () => {
      expect(matchRule(rule({ host: "93.184.216.34" }), req({ url: "https://93.184.216.34/" }))).toBe(false);
    });

    it("ignores userinfo and matches against the real host, not the userinfo label", () => {
      const r = rule({ host: "evil.com" });
      expect(matchRule(r, req({ url: "https://a.example@evil.com/" }))).toBe(true);
      expect(matchRule(rule({ host: "a.example" }), req({ url: "https://a.example@evil.com/" }))).toBe(false);
    });

    it("does not let a look-alike subdomain match an exact-host rule", () => {
      expect(matchRule(rule({ host: "foo.vercel.app" }), req({ url: "https://foo.vercel.app.evil.com/" }))).toBe(
        false,
      );
    });

    it("does not treat a wildcard base match as a substring match on an unrelated eTLD", () => {
      expect(matchRule(rule({ host: "*.vercel.app" }), req({ url: "https://evilfoo-vercel.app/" }))).toBe(false);
    });

    it("does allow a wildcard rule to match any one-label subdomain, including a confusable-looking one", () => {
      // Documented residual risk (design §11 decision 4), not a bug: an
      // agent can never author this rule, only a human via Settings can.
      expect(matchRule(rule({ host: "*.vercel.app" }), req({ url: "https://evilfoo.vercel.app/" }))).toBe(true);
    });

    it("rejects a wildcard rule matching its own bare base", () => {
      expect(matchRule(rule({ host: "*.vercel.app" }), req({ url: "https://vercel.app/" }))).toBe(false);
    });

    it("accepts a wildcard rule matching exactly one extra label", () => {
      expect(matchRule(rule({ host: "*.vercel.app" }), req({ url: "https://foo.vercel.app/" }))).toBe(true);
    });

    it("allows http:// on localhost when allowLoopbackHttp is set", () => {
      // The rule's `port` is the source of truth even for the loopback
      // exception (no separate http default), so it must match the dev
      // server's actual port explicitly.
      const r = rule({ host: "localhost", port: 3000, allowLoopbackHttp: true });
      expect(matchRule(r, req({ url: "http://localhost:3000/" }))).toBe(true);
    });

    it("allows http:// on 127.0.0.1 when allowLoopbackHttp is set", () => {
      const r = rule({ host: "127.0.0.1", port: 3000, allowLoopbackHttp: true });
      expect(matchRule(r, req({ url: "http://127.0.0.1:3000/" }))).toBe(true);
    });

    it("rejects http:// on loopback when allowLoopbackHttp is absent", () => {
      const r = rule({ host: "localhost", port: 3000 });
      expect(matchRule(r, req({ url: "http://localhost:3000/" }))).toBe(false);
    });

    it("rejects http:// on loopback when allowLoopbackHttp is explicitly false", () => {
      const r = rule({ host: "localhost", port: 3000, allowLoopbackHttp: false });
      expect(matchRule(r, req({ url: "http://localhost:3000/" }))).toBe(false);
    });

    it("rejects http:// on a non-loopback host even with allowLoopbackHttp set", () => {
      const r = rule({ host: "foo.vercel.app", allowLoopbackHttp: true });
      expect(matchRule(r, req({ url: "http://foo.vercel.app/" }))).toBe(false);
    });
  });

  describe("initiator table", () => {
    it("matches a mainFrame request on URL alone, regardless of initiator", () => {
      expect(matchRule(rule(), req({ resourceType: "mainFrame", initiatorUrl: null }))).toBe(true);
      expect(
        matchRule(rule(), req({ resourceType: "mainFrame", initiatorUrl: "https://elsewhere.example/" })),
      ).toBe(true);
    });

    it("allows a subresource whose initiator is within the same rule's scope", () => {
      expect(
        matchRule(
          rule(),
          req({ resourceType: "image", initiatorUrl: "https://foo.vercel.app/page", url: "https://foo.vercel.app/logo.png" }),
        ),
      ).toBe(true);
      expect(
        matchRule(
          rule(),
          req({ resourceType: "xhr", initiatorUrl: "https://foo.vercel.app/page", url: "https://foo.vercel.app/api" }),
        ),
      ).toBe(true);
    });

    it("denies a subresource whose initiator is a different host", () => {
      expect(
        matchRule(rule(), req({ resourceType: "image", initiatorUrl: "https://evil.example/" })),
      ).toBe(false);
    });

    it("denies a subresource with a null initiator", () => {
      expect(matchRule(rule(), req({ resourceType: "image", initiatorUrl: null }))).toBe(false);
    });

    it("denies a subresource with a blob: initiator", () => {
      expect(
        matchRule(rule(), req({ resourceType: "image", initiatorUrl: "blob:https://foo.vercel.app/uuid" })),
      ).toBe(false);
    });

    it("denies a subresource with an unparseable initiator instead of throwing", () => {
      expect(() =>
        matchRule(rule(), req({ resourceType: "image", initiatorUrl: "not a url" })),
      ).not.toThrow();
      expect(matchRule(rule(), req({ resourceType: "image", initiatorUrl: "not a url" }))).toBe(false);
    });
  });

  it("never throws on an unparseable request URL", () => {
    expect(() => matchRule(rule(), req({ url: "not a url" }))).not.toThrow();
    expect(matchRule(rule(), req({ url: "not a url" }))).toBe(false);
  });

  describe("simulated redirect (per-leg matching, not a live redirect)", () => {
    it("matches leg 1 on host A and stops matching after a 302 to host B", () => {
      const r = rule({ host: "a.example" });
      const leg1 = req({ url: "https://a.example/start" });
      const leg2 = req({ url: "https://b.example/after-redirect" });

      expect(matchRule(r, leg1)).toBe(true);
      expect(matchRule(r, leg2)).toBe(false);
    });
  });
});

describe("applyRuleHeader", () => {
  it("overrides a page-set header case-insensitively, leaving exactly one key", () => {
    const headers: Record<string, string> = { "X-Vercel-Protection-Bypass": "page-supplied-value" };
    applyRuleHeader(rule(), "secret-value", headers);

    expect(Object.keys(headers)).toEqual(["x-vercel-protection-bypass"]);
    expect(headers["x-vercel-protection-bypass"]).toBe("secret-value");
  });

  it("prepends valuePrefix when set", () => {
    const headers: Record<string, string> = {};
    applyRuleHeader(rule({ header: "authorization", valuePrefix: "Bearer " }), "token123", headers);
    expect(headers.authorization).toBe("Bearer token123");
  });

  it("sets the header fresh when nothing was present before", () => {
    const headers: Record<string, string> = {};
    applyRuleHeader(rule(), "secret-value", headers);
    expect(headers["x-vercel-protection-bypass"]).toBe("secret-value");
  });
});

describe("scrubMatchedSecretValue", () => {
  it("removes a header whose value equals a tracked secret value", () => {
    const headers: Record<string, string> = { "x-vercel-protection-bypass": "leaked-secret" };
    const removed = scrubMatchedSecretValue("x-vercel-protection-bypass", headers, ["leaked-secret", "other"]);

    expect(removed).toBe(true);
    expect(headers["x-vercel-protection-bypass"]).toBeUndefined();
  });

  it("leaves a header alone when its value does not equal any tracked secret", () => {
    const headers: Record<string, string> = { "x-vercel-protection-bypass": "not-a-secret" };
    const removed = scrubMatchedSecretValue("x-vercel-protection-bypass", headers, ["leaked-secret"]);

    expect(removed).toBe(false);
    expect(headers["x-vercel-protection-bypass"]).toBe("not-a-secret");
  });

  it("does the header-name lookup case-insensitively", () => {
    const headers: Record<string, string> = { "X-Vercel-Protection-Bypass": "leaked-secret" };
    const removed = scrubMatchedSecretValue("x-vercel-protection-bypass", headers, ["leaked-secret"]);

    expect(removed).toBe(true);
    expect(headers["X-Vercel-Protection-Bypass"]).toBeUndefined();
  });

  it("returns false when the header is absent", () => {
    expect(scrubMatchedSecretValue("x-missing", {}, ["anything"])).toBe(false);
  });
});

describe("isHeaderAllowedForCreator", () => {
  const forbidden = [
    "host",
    "content-type",
    "content-length",
    "transfer-encoding",
    "connection",
    "upgrade",
    "proxy-connection",
    "sec-ch-ua",
    "origin",
    "referer",
    "user-agent",
  ];

  it.each(forbidden)("rejects %s for an agent-created rule", (header) => {
    expect(isHeaderAllowedForCreator(header, "agent")).toBe(false);
  });

  // Design §11 decision 10 supersedes §5.1's static table: Authorization/Cookie
  // (and, per §6, Proxy-Authorization) are allowed for agent rules too, behind
  // a stronger approval-modal warning (`requiresStrongWarning`), not a ban.
  it.each(["authorization", "cookie", "proxy-authorization"])(
    "allows %s for an agent-created rule (warned, not banned, per design §11 decision 10)",
    (header) => {
      expect(isHeaderAllowedForCreator(header, "agent")).toBe(true);
      expect(isHeaderAllowedForCreator(header.toUpperCase(), "agent")).toBe(true);
    },
  );

  it("allows authorization for a user-created rule", () => {
    expect(isHeaderAllowedForCreator("authorization", "user")).toBe(true);
  });

  it("allows an arbitrary custom header for both creators", () => {
    expect(isHeaderAllowedForCreator("x-my-custom-header", "agent")).toBe(true);
    expect(isHeaderAllowedForCreator("x-my-custom-header", "user")).toBe(true);
  });
});

describe("requiresStrongWarning", () => {
  it.each(["authorization", "cookie", "proxy-authorization", "Authorization", "Cookie", "Proxy-Authorization"])(
    "flags %s",
    (header) => {
      expect(requiresStrongWarning(header)).toBe(true);
    },
  );

  it("does not flag an ordinary header", () => {
    expect(requiresStrongWarning("x-vercel-protection-bypass")).toBe(false);
  });
});

describe("isValidHeaderValue", () => {
  it("rejects CR and LF", () => {
    expect(isValidHeaderValue("value\r\ninjected: true")).toBe(false);
    expect(isValidHeaderValue("value\r")).toBe(false);
    expect(isValidHeaderValue("value\n")).toBe(false);
  });

  it("rejects other control characters", () => {
    expect(isValidHeaderValue("value\u0000")).toBe(false);
    expect(isValidHeaderValue("value\u0007")).toBe(false);
    expect(isValidHeaderValue("value\u007F")).toBe(false);
  });

  it("accepts a normal token / Bearer-style value", () => {
    expect(isValidHeaderValue("Bearer abc123.def456~ghi")).toBe(true);
    expect(isValidHeaderValue("")).toBe(true);
  });
});

describe("expiry", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");

  it("is never expired when expiresAt is absent (permanent rule)", () => {
    expect(isRuleExpired(rule({ expiresAt: undefined, createdBy: "user" }), now)).toBe(false);
  });

  it("is expired once now is at or after expiresAt", () => {
    expect(isRuleExpired(rule({ expiresAt: "2026-09-28T11:00:00.000Z" }), now)).toBe(true);
    expect(isRuleExpired(rule({ expiresAt: "2026-09-28T12:00:00.000Z" }), now)).toBe(true);
  });

  it("is not expired while now is before expiresAt", () => {
    expect(isRuleExpired(rule({ expiresAt: "2026-09-28T13:00:00.000Z" }), now)).toBe(false);
  });

  it("prunes only the expired rules", () => {
    const fresh = rule({ id: "fresh", expiresAt: "2026-09-28T13:00:00.000Z" });
    const stale = rule({ id: "stale", expiresAt: "2026-09-28T11:00:00.000Z" });
    const permanent = rule({ id: "permanent", expiresAt: undefined, createdBy: "user" });

    expect(pruneExpiredRules([fresh, stale, permanent], now)).toEqual([fresh, permanent]);
  });
});

describe("createHeaderRule", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");

  function input(overrides: Partial<Parameters<typeof createHeaderRule>[0]> = {}) {
    return {
      host: "foo.vercel.app",
      header: "x-vercel-protection-bypass",
      secretId: "ct-secret-rbcodelabs-vercel-bypass",
      createdBy: "agent" as const,
      ...overrides,
    };
  }

  it("rejects a forbidden agent header", () => {
    expect(() => createHeaderRule(input({ header: "sec-ch-ua" }), now)).toThrow(HeaderRuleValidationError);
  });

  it("allows cookie for an agent-created rule (warned, not banned, per design §11 decision 10)", () => {
    const created = createHeaderRule(input({ header: "cookie" }), now);
    expect(created.header).toBe("cookie");
  });

  it("rejects a CR/LF value in valuePrefix", () => {
    expect(() => createHeaderRule(input({ valuePrefix: "Bearer \r\nx-evil: 1" }), now)).toThrow(
      HeaderRuleValidationError,
    );
  });

  it("rejects an invalid secretId", () => {
    expect(() => createHeaderRule(input({ secretId: "../escape" }), now)).toThrow(HeaderRuleValidationError);
  });

  it("clamps an agent TTL request above the 24h max", () => {
    const created = createHeaderRule(input({ ttlMs: 999 * 60 * 60 * 1000 }), now);
    expect(new Date(created.expiresAt!).getTime() - now.getTime()).toBe(MAX_AGENT_TTL_MS);
  });

  it("clamps a negative agent TTL request up to 0", () => {
    const created = createHeaderRule(input({ ttlMs: -1000 }), now);
    expect(created.expiresAt).toBe(now.toISOString());
  });

  it("defaults to the 4h TTL when unspecified", () => {
    const created = createHeaderRule(input(), now);
    expect(new Date(created.expiresAt!).getTime() - now.getTime()).toBe(DEFAULT_AGENT_TTL_MS);
  });

  it("allows a permanent user-created rule with no expiresAt", () => {
    const created = createHeaderRule(input({ createdBy: "user", header: "authorization" }), now);
    expect(created.expiresAt).toBeUndefined();
  });

  it("rejects allowLoopbackHttp on a non-loopback host at creation time", () => {
    expect(() => createHeaderRule(input({ allowLoopbackHttp: true }), now)).toThrow(HeaderRuleValidationError);
  });

  it("accepts allowLoopbackHttp on localhost", () => {
    const created = createHeaderRule(input({ host: "localhost", allowLoopbackHttp: true }), now);
    expect(created.allowLoopbackHttp).toBe(true);
    expect(created.host).toBe("localhost");
  });

  it("fills in id, createdAt, approvedAt, and lowercases host/header", () => {
    const created = createHeaderRule(input({ host: "FOO.VERCEL.APP", header: "X-Custom-Header" }), now);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.createdAt).toBe(now.toISOString());
    expect(created.approvedAt).toBe(now.toISOString());
    expect(created.host).toBe("foo.vercel.app");
    expect(created.header).toBe("x-custom-header");
    expect(created.surfaces).toEqual(["agent-browser"]);
  });
});

describe("HeaderRuleStore", () => {
  const tempDirs: string[] = [];
  function storePath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-header-rule-store-"));
    tempDirs.push(dir);
    return path.join(dir, "browser-header-rules.json");
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty against a file that does not exist yet", () => {
    const store = new HeaderRuleStore(storePath());
    expect(store.list()).toEqual([]);
  });

  it("round-trips an added rule across store instances", async () => {
    const file = storePath();
    const store = new HeaderRuleStore(file);
    store.add(rule({ id: "a" }));
    await store.flush();

    const reopened = new HeaderRuleStore(file);
    expect(reopened.list().map((r) => r.id)).toEqual(["a"]);
  });

  it("never writes a secret value to disk, only secretId", async () => {
    const file = storePath();
    const store = new HeaderRuleStore(file);
    store.add(rule({ id: "a", secretId: "ct-secret-my-thing" }));
    await store.flush();

    const onDisk = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(onDisk);
    expect(parsed).toEqual({ version: 1, rules: [expect.objectContaining({ secretId: "ct-secret-my-thing" })] });
  });

  it("removes a rule by id and reports whether it existed", async () => {
    const file = storePath();
    const store = new HeaderRuleStore(file);
    store.add(rule({ id: "a" }));
    store.add(rule({ id: "b" }));
    await store.flush();

    expect(store.remove("a")).toBe(true);
    await store.flush();
    expect(store.remove("a")).toBe(false);

    expect(new HeaderRuleStore(file).list().map((r) => r.id)).toEqual(["b"]);
  });

  it("prunes expired rules on load and persists the pruned result", async () => {
    const file = storePath();
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        rules: [
          rule({ id: "expired", expiresAt: "2000-01-01T00:00:00.000Z" }),
          rule({ id: "alive", expiresAt: "2999-01-01T00:00:00.000Z" }),
        ],
      }),
    );

    const store = new HeaderRuleStore(file);
    expect(store.list().map((r) => r.id)).toEqual(["alive"]);
    await store.flush();

    expect(JSON.parse(fs.readFileSync(file, "utf8")).rules.map((r: HeaderRule) => r.id)).toEqual(["alive"]);
  });

  it("survives a corrupt rules file rather than throwing on first read", () => {
    const file = storePath();
    fs.writeFileSync(file, "{not json");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const store = new HeaderRuleStore(file);
    expect(store.list()).toEqual([]);
  });
});
