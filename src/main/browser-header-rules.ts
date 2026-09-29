import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as crypto from "node:crypto";
import { writeJsonAtomic } from "./config-file";
import { isValidSecretId } from "./secret-store";

/**
 * Secret-backed request-header rules for the agent browser.
 *
 * ## Why this file exists
 *
 * The in-app agent browser (`persist:agent-browser`) has no way to attach a
 * custom request header, so an agent that needs one (e.g. Vercel's
 * `x-vercel-protection-bypass`) has historically had to put the secret in the
 * URL — which then gets echoed into `browser_navigate`'s return value and
 * saved into the auto-persisted thread transcript. A `HeaderRule` lets an
 * agent (with human approval, enforced elsewhere — see below) or a human
 * (Settings, later) say "attach this secret, under this header name, to
 * requests to exactly this host" without the value ever passing through a
 * tool argument.
 *
 * This module is deliberately Electron-free, mirroring `secret-store.ts`'s
 * `SecretCrypto` injection pattern: it holds the pure matcher, the on-disk
 * rule list, and the header-mutation helpers, so it unit-tests under plain
 * vitest/node. It does NOT resolve `secretId` to a value (that needs
 * `SecretStore`, which needs `safeStorage`), does not bind to any Electron
 * `Session`, and does not expose IPC — those are `guest-request-pipeline.ts`
 * integration and IPC/preload wiring, done in a follow-up task. Nothing here
 * should ever `import "electron"`.
 *
 * The two halves worth keeping separate in your head:
 * - `matchRule` / `applyRuleHeader` / `scrubMatchedSecretValue`: pure
 *   functions over a single request. The eventual `HeaderStage` in
 *   `guest-request-pipeline.ts` will be a thin adapter around these three.
 * - `HeaderRuleStore`: the on-disk `{ version, rules }` file, holding only
 *   `secretId` references — never secret values — same as `secrets.json`
 *   never holds plaintext.
 */

/** v1 ships exactly one surface. The tuple type leaves room for a second later without a schema break. */
export type HeaderRuleSurface = "agent-browser";

export type HeaderRuleCreator = "user" | "agent";

export interface HeaderRule {
  /** `crypto.randomUUID()`. */
  id: string;
  /** Exact lowercase punycode hostname, no trailing dot. `"*.x.y"` is user-authored only (Settings, later). */
  host: string;
  /** Defaults to 443 when absent — including for the loopback-http exception; see `matchRule`. */
  port?: number;
  /** Lowercased RFC 7230 token. Forbidden set for `createdBy: "agent"` enforced by `isHeaderAllowedForCreator`. */
  header: string;
  /** `SecretStore` id (`isValidSecretId`). A reference only; this module never sees or stores the value. */
  secretId: string;
  /** Prepended to the resolved secret value, e.g. `"Bearer "`. */
  valuePrefix?: string;
  surfaces: [HeaderRuleSurface];
  createdBy: HeaderRuleCreator;
  /** Untrusted display string (thread id/title) shown in the approval UI. Never trusted for access control. */
  requester?: string;
  /** Opt-in exception (design §11 Q6) allowing `http://` on `localhost` / `127.0.0.1` / `::1` only. */
  allowLoopbackHttp?: boolean;
  createdAt: string;
  /** Absent means permanent — only legal for `createdBy: "user"` rules (Settings pre-approval path). */
  expiresAt?: string;
  approvedAt: string;
}

/** The one request leg under consideration. Deliberately Electron-free — no `OnBeforeSendHeadersListenerDetails`. */
export interface MatchableRequest {
  url: string;
  resourceType: string;
  /**
   * The requesting frame's URL (Electron's `details.frame?.url`), required for
   * every non-`mainFrame` resource type. `null` fails closed rather than matching.
   */
  initiatorUrl: string | null;
}

export class HeaderRuleValidationError extends Error {}

// ---------------------------------------------------------------------------
// Header name / value validation
// ---------------------------------------------------------------------------

/**
 * Names an agent-created rule may never target, per design §5.1's threat
 * model: these either break the request outright (`host`, `content-*`,
 * `transfer-encoding`, `connection`, `upgrade`), leak cross-cutting identity
 * (`origin`, `referer`, `user-agent`), or touch infra plumbing an agent has no
 * business rewriting (`proxy-*` other than `proxy-authorization`, `sec-*`).
 *
 * `cookie`/`authorization`/`proxy-authorization` are NOT in this denylist even
 * though §5.1's own table lists `cookie` as forbidden and `authorization` as
 * user-only: design §11 decision 10 (settled by Rick, the same document) later
 * supersedes that table — "`Authorization`/`Cookie`... allowed for
 * agent-created rules, with a stronger warning line in the approval modal
 * (rather than banned outright). This replaces the earlier 'ban' proposal in
 * section 6/threat model." §6's tool-invocation table extends the same
 * warning to `Proxy-Authorization`. `requiresStrongWarning` below flags those
 * three for the P1b/P2 approval modal; this module only decides allow/forbid.
 *
 * Deliberately scoped to `createdBy: "agent"` only — a human using a future
 * Settings UI is trusted with any header name, same as they are trusted with
 * `*.` wildcards that an agent can never author.
 */
const FORBIDDEN_AGENT_HEADER_NAMES = new Set([
  "host",
  "transfer-encoding",
  "connection",
  "upgrade",
  "origin",
  "referer",
  "user-agent",
]);
const FORBIDDEN_AGENT_HEADER_PREFIXES = ["content-", "sec-"];
/** Carve-out from the `proxy-*` prefix ban: allowed (with a strong warning), per design §6. */
const PROXY_HEADER_ALLOWLIST = new Set(["proxy-authorization"]);

/** RFC 7230 `token` characters: `tchar` repeated one or more times. */
const HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Every name in the denylist above (and every `proxy-*` name except
 * `proxy-authorization`) is forbidden for `createdBy: "agent"` only; a
 * `"user"`-created rule may target any header.
 */
export function isHeaderAllowedForCreator(header: string, createdBy: HeaderRuleCreator): boolean {
  if (createdBy !== "agent") return true;
  const lower = header.toLowerCase();
  if (FORBIDDEN_AGENT_HEADER_NAMES.has(lower)) return false;
  if (lower.startsWith("proxy-")) return PROXY_HEADER_ALLOWLIST.has(lower);
  return FORBIDDEN_AGENT_HEADER_PREFIXES.every((prefix) => !lower.startsWith(prefix));
}

/**
 * Headers whose approval-modal entry (P1b/P2) must carry a stronger warning
 * line, per design §6/§11 decision 10: `Authorization`, `Cookie`, and
 * `Proxy-Authorization` are allowed on agent-created rules but let the rule
 * exfiltrate a login session rather than "just" a bypass token. Case-insensitive.
 */
export function requiresStrongWarning(header: string): boolean {
  const lower = header.toLowerCase();
  return lower === "authorization" || lower === "cookie" || lower === "proxy-authorization";
}

/** Printable ASCII only (0x20-0x7E). Rejects CR/LF and every other control character in one check. */
const VISIBLE_ASCII_PATTERN = /^[\x20-\x7E]*$/;

export function isValidHeaderValue(value: string): boolean {
  return typeof value === "string" && VISIBLE_ASCII_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Matching (design §5.2)
// ---------------------------------------------------------------------------

/**
 * The three loopback hostnames the opt-in `allowLoopbackHttp` exception
 * covers. `URL.hostname` for `http://[::1]:3000` is the bracketed literal
 * `"[::1]"`, not `"::1"` — this set uses the same bracketed form so it can be
 * compared directly against `url.hostname` without re-deriving it.
 */
const LOOPBACK_URL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Same three hosts, accepting either the bracketed or bare IPv6 form — used only at rule-creation time, not matching. */
const LOOPBACK_HOST_INPUTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parseUrlSafely(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function stripTrailingDot(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/** `net.isIP` takes a bare address; strip the brackets Node's URL parser puts around an IPv6 literal first. */
function isIpLiteralHostname(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return net.isIP(bare) !== 0;
}

/**
 * `rule.host` starting with `"*."` is a wildcard base: it matches any
 * hostname with at least one extra label under that base, but never the base
 * itself (`*.vercel.app` must not match bare `vercel.app`). Otherwise this is
 * an exact match. Never a substring match either way — `endsWith` is always
 * anchored on a full-label boundary via the leading dot.
 */
function hostMatchesRule(hostname: string, ruleHost: string): boolean {
  if (ruleHost.startsWith("*.")) {
    const base = ruleHost.slice(2);
    return hostname !== base && hostname.endsWith(`.${base}`);
  }
  return hostname === ruleHost;
}

/**
 * The single-leg check shared by the request URL and (recursively) the
 * initiator URL: protocol/IP-literal gate, port, then host. Kept separate
 * from `matchRule` so the initiator check is exactly the same logic as the
 * top-level URL check, not a hand-rolled approximation of it.
 */
function legMatches(url: URL, rule: HeaderRule): boolean {
  const hostname = stripTrailingDot(url.hostname);
  const isLoopbackException =
    !!rule.allowLoopbackHttp && url.protocol === "http:" && LOOPBACK_URL_HOSTNAMES.has(hostname);

  if (!isLoopbackException) {
    if (url.protocol !== "https:") return false;
    if (isIpLiteralHostname(hostname)) return false;
  }

  // The rule's `port` is the source of truth, defaulting to 443 in every case
  // (including the loopback-http exception) — there is no separate http default.
  const port = url.port === "" ? 443 : Number(url.port);
  if (port !== (rule.port ?? 443)) return false;

  return hostMatchesRule(hostname, rule.host);
}

/**
 * Pure per-request-leg matcher (design §5.2). Never throws: an unparseable
 * `req.url` or `req.initiatorUrl` is treated as "no match," not an error, so
 * a caller in a `webRequest` listener never needs its own try/catch around
 * this call.
 *
 * `req.url`'s userinfo (`https://a.example@evil.com/`) is ignored entirely —
 * `URL.hostname` never includes it, so `https://a.example@evil.com/` matches
 * against `evil.com`, never `a.example`, with no special-casing needed here.
 */
export function matchRule(rule: HeaderRule, req: MatchableRequest): boolean {
  const url = parseUrlSafely(req.url);
  if (!url) return false;
  if (!legMatches(url, rule)) return false;

  if (req.resourceType === "mainFrame") return true;

  // Subresources and subframes must also have an initiator within scope —
  // fails closed on null, unparseable, or a blob:/about:/data: URL (none of
  // those have an https-shaped `.hostname`, so `legMatches` rejects them
  // without any scheme-specific special-casing).
  if (!req.initiatorUrl) return false;
  const initiatorUrl = parseUrlSafely(req.initiatorUrl);
  if (!initiatorUrl) return false;
  return legMatches(initiatorUrl, rule);
}

// ---------------------------------------------------------------------------
// Header mutation (design §5.2 step 5, and the scrub backstop)
// ---------------------------------------------------------------------------

/**
 * `set` semantics: delete any existing key matching `rule.header`
 * case-insensitively, then set the canonical-cased `rule.header` key. This
 * means a page that pre-set the same header (under any casing) cannot
 * pre-empt or duplicate the rule's value. Mutates `headers` in place.
 */
export function applyRuleHeader(rule: HeaderRule, secretValue: string, headers: Record<string, string>): void {
  const target = rule.header.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) delete headers[key];
  }
  headers[rule.header] = `${rule.valuePrefix ?? ""}${secretValue}`;
}

/**
 * Defence in depth (design §5.2 final paragraph): for a request that did NOT
 * match a rule using `headerName`, remove that header anyway if its value
 * happens to equal one of the tracked secret values. This is the guard
 * against Chromium carrying a webRequest-added header across a redirect leg
 * to a host the rule never intended it for (UNVERIFIED live behavior, see
 * design §12 — this function is the mitigation regardless of the answer).
 *
 * Pure and rule-agnostic: the caller (P1b) is responsible for knowing which
 * header name and which secret values are "active but not matched here."
 */
export function scrubMatchedSecretValue(
  headerName: string,
  headers: Record<string, string>,
  activeSecretValues: Iterable<string>,
): boolean {
  const target = headerName.toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === target);
  if (key === undefined) return false;
  const value = headers[key];
  for (const secretValue of activeSecretValues) {
    if (value === secretValue) {
      delete headers[key];
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/** Agent-created rules default to this TTL when none is requested. */
export const DEFAULT_AGENT_TTL_MS = 4 * 60 * 60 * 1000;
/** Agent-created rules can never exceed this TTL, regardless of what was requested (design §11 decision 3). */
export const MAX_AGENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Absent `expiresAt` means permanent — only ever legal for `createdBy: "user"` rules. */
export function isRuleExpired(rule: HeaderRule, now: Date): boolean {
  if (!rule.expiresAt) return false;
  return now.getTime() >= new Date(rule.expiresAt).getTime();
}

export function pruneExpiredRules(rules: HeaderRule[], now: Date): HeaderRule[] {
  return rules.filter((rule) => !isRuleExpired(rule, now));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateHeaderRuleInput {
  host: string;
  port?: number;
  header: string;
  secretId: string;
  valuePrefix?: string;
  createdBy: HeaderRuleCreator;
  requester?: string;
  allowLoopbackHttp?: boolean;
  /**
   * Agent-created rules only: clamped into `[0, MAX_AGENT_TTL_MS]` and
   * defaulted to `DEFAULT_AGENT_TTL_MS` when absent. Ignored for
   * `createdBy: "user"` — use `expiresAt` directly for those (or omit it for
   * a permanent rule).
   */
  ttlMs?: number;
  /** `createdBy: "user"` only. Absent means a permanent rule. */
  expiresAt?: string;
}

/**
 * `browser-header-rules-list` IPC response shape (P1b). Never includes the
 * resolved secret value — only whether one is currently present, so the
 * renderer/plugin can distinguish an inert rule (missing secret) from an
 * active one without ever seeing what the secret is.
 */
export interface HeaderRuleSummary {
  id: string;
  host: string;
  header: string;
  secretId: string;
  secretPresent: boolean;
  createdBy: HeaderRuleCreator;
  expiresAt?: string;
}

/**
 * `browser-header-rules-add` IPC response shape (P1b subset of design §6's
 * fuller agent-tool status enum — `secret_missing`/`unavailable`/
 * `secret_not_visible` belong to the plugin-side tool wrapper built in P2).
 */
export type HeaderRuleAddResult =
  | { success: true; ruleId: string; host: string; header: string; expiresAt?: string }
  | { success: false; status: "invalid"; message: string }
  | { success: false; status: "declined" };

/**
 * Validates and fills in a `HeaderRule`: `id`, `createdAt`/`approvedAt` (both
 * `now`), and — for `createdBy: "agent"` — a clamped `expiresAt`. Throws
 * `HeaderRuleValidationError` for anything that would otherwise persist an
 * unusable or unsafe rule; the caller (P1b's IPC `add()` handler) is expected
 * to turn that into a typed failure response rather than letting it escape
 * to the renderer as an unhandled IPC rejection.
 */
export function createHeaderRule(input: CreateHeaderRuleInput, now: Date = new Date()): HeaderRule {
  if (typeof input.host !== "string" || input.host.length === 0) {
    throw new HeaderRuleValidationError("host is required");
  }
  if (!HEADER_TOKEN_PATTERN.test(input.header)) {
    throw new HeaderRuleValidationError(`Invalid header name: ${JSON.stringify(input.header)}`);
  }
  const header = input.header.toLowerCase();
  if (!isHeaderAllowedForCreator(header, input.createdBy)) {
    throw new HeaderRuleValidationError(
      `Header "${header}" is not allowed for ${input.createdBy}-created rules`,
    );
  }
  if (!isValidSecretId(input.secretId)) {
    throw new HeaderRuleValidationError(`Invalid secretId: ${JSON.stringify(input.secretId)}`);
  }
  if (input.valuePrefix !== undefined && !isValidHeaderValue(input.valuePrefix)) {
    throw new HeaderRuleValidationError("valuePrefix contains control characters or CR/LF");
  }

  const host = input.host.toLowerCase();
  if (input.allowLoopbackHttp) {
    const base = host.startsWith("*.") ? host.slice(2) : host;
    if (!LOOPBACK_HOST_INPUTS.has(base)) {
      throw new HeaderRuleValidationError(
        `allowLoopbackHttp is only valid for localhost/127.0.0.1/::1, got ${JSON.stringify(input.host)}`,
      );
    }
  }

  const createdAt = now.toISOString();
  let expiresAt: string | undefined;
  if (input.createdBy === "agent") {
    const ttlMs = clamp(input.ttlMs ?? DEFAULT_AGENT_TTL_MS, 0, MAX_AGENT_TTL_MS);
    expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    // Unreachable given the assignment above; guards the invariant explicitly
    // rather than trusting the arithmetic silently forever.
    if (!expiresAt) throw new HeaderRuleValidationError("Agent-created rules must have an expiry");
  } else {
    expiresAt = input.expiresAt;
  }

  return {
    id: crypto.randomUUID(),
    host,
    port: input.port,
    header,
    secretId: input.secretId,
    valuePrefix: input.valuePrefix,
    surfaces: ["agent-browser"],
    createdBy: input.createdBy,
    requester: input.requester,
    allowLoopbackHttp: input.allowLoopbackHttp,
    createdAt,
    expiresAt,
    approvedAt: createdAt,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface PersistedHeaderRules {
  version: 1;
  rules: HeaderRule[];
}

/**
 * On-disk rule list, mirroring `SecretStore`'s shape: a single JSON file
 * written via `writeJsonAtomic`, loaded once per process, writes serialized
 * behind a promise chain so rapid `add`/`remove` calls cannot interleave
 * their atomic replaces. Never holds a secret value — only `secretId`.
 *
 * The caller supplies `filePath` (P1b will pass
 * `path.join(app.getPath("userData"), "browser-header-rules.json")`) so this
 * class never touches `electron` itself.
 */
export class HeaderRuleStore {
  private rules: HeaderRule[] | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  list(now: Date = new Date()): HeaderRule[] {
    return [...this.load(now)];
  }

  add(rule: HeaderRule, now: Date = new Date()): void {
    const rules = [...this.load(now), rule];
    this.persist(rules);
  }

  /** Returns whether a rule with this id existed and was removed. */
  remove(id: string, now: Date = new Date()): boolean {
    const rules = this.load(now);
    const index = rules.findIndex((rule) => rule.id === id);
    if (index === -1) return false;
    const next = [...rules.slice(0, index), ...rules.slice(index + 1)];
    this.persist(next);
    return true;
  }

  /** Resolves once every queued write has landed. Tests use this; production code generally doesn't need to. */
  flush(): Promise<void> {
    return this.writes;
  }

  /**
   * Loads once per process, pruning expired rules and best-effort persisting
   * the pruned result back — matching `secret-store.ts`'s defensive style, a
   * failed write here must never turn into a failed load.
   */
  private load(now: Date): HeaderRule[] {
    if (this.rules) return this.rules;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("Header rules: failed to read rules file", error);
      }
      this.rules = [];
      return this.rules;
    }

    let parsed: PersistedHeaderRules;
    try {
      parsed = JSON.parse(raw) as PersistedHeaderRules;
    } catch (error) {
      console.error("Header rules: rules file is not valid JSON; ignoring", error);
      this.rules = [];
      return this.rules;
    }

    const loaded = Array.isArray(parsed?.rules) ? parsed.rules : [];
    const pruned = pruneExpiredRules(loaded, now);
    this.rules = pruned;
    if (pruned.length !== loaded.length) this.persist(pruned);
    return pruned;
  }

  private persist(rules: HeaderRule[]): void {
    this.rules = rules;
    const payload: PersistedHeaderRules = { version: 1, rules };
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        await writeJsonAtomic(this.filePath, payload);
      })
      .catch((error) => {
        console.error("Header rules: failed to write rules file", error);
      });
  }
}
