import { hubUrlProblem } from "./hub-sync";

/**
 * Pure decision functions for the `sync` area of the managed policy (docs/adr/0053-sync-policy.md). Shared by the main
 * process (which enforces: the hub, iCloud and guarded-apply handlers) and the renderer (advisory only: the renderer runs
 * with nodeIntegration, so a renderer-side refusal is a courtesy and a UI hint, never a security boundary).
 *
 * Input is the effective `sync` block from `get-effective-policy` (machine and vault layers already merged by
 * `resolveEffectivePolicy`). Every function returns `null` when the operation is allowed, else a message that names the
 * policy. Missing or invalid policy is the caller's concern: it passes `null`/`undefined`, and that allows everything (fail
 * open, docs/adr/0002). Nothing here caches or reads files.
 */
export interface SyncPolicyView {
  /** `false` is the kill switch. */
  enabled?: boolean;
  /** Provider ids the policy allows. Absent = all. An empty list (or the validator's fail-closed sentinel) allows none. */
  providers?: string[];
  /** Exact hub origins (scheme + host + port). Absent = no restriction. */
  hubAllowlist?: string[];
}

export type SyncPolicyInput = SyncPolicyView | null | undefined;

/** Error code carried by refusals so UIs and tests can tell a policy block from a transport failure. */
export const SYNC_POLICY_BLOCKED = "policy-blocked";

export const SYNC_DISABLED_MESSAGE = "blocked by administrator policy: sync is turned off";

/**
 * Policy provider ids are `hub` and `icloud` (the validator's token grammar has no `.`), but the built-in hub provider
 * registers as `geode.hub`. Both spellings name the hub. Any other id (a plugin-provided provider) is matched verbatim.
 */
export function policyProviderId(id: string): string {
  return id === "geode.hub" ? "hub" : id;
}

/** Whether sync as a whole is switched off. */
export function syncDisabledReason(policy: SyncPolicyInput): string | null {
  return policy && policy.enabled === false ? SYNC_DISABLED_MESSAGE : null;
}

/** Kill switch first, then the provider narrowing. */
export function syncProviderBlockReason(policy: SyncPolicyInput, providerId: string): string | null {
  const disabled = syncDisabledReason(policy);
  if (disabled) return disabled;
  if (!policy || !Array.isArray(policy.providers)) return null;
  const id = policyProviderId(providerId);
  if (policy.providers.includes(id)) return null;
  const allowed = policy.providers.filter((p) => p !== "!none");
  return `blocked by administrator policy: sync provider "${id}" is not permitted${allowed.length ? ` (allowed: ${allowed.join(", ")})` : " (no sync providers are permitted)"}`;
}

/**
 * The origin (scheme, host, port) a hub URL would connect to, or `null` when the URL is not a usable hub URL. Uses the
 * same grammar the settings UI and the connection code use (`hubUrlProblem`: https/wss only, printable ASCII, no
 * credentials, no backslash) and the WHATWG parser's `origin`, so what is compared is what is dialled: host lower-cased
 * and punycoded, default port dropped, userinfo and path ignored. A trailing dot on the host is NOT stripped, so
 * `hub.example.` does not match `hub.example`.
 */
export function hubUrlOrigin(url: unknown): string | null {
  if (hubUrlProblem(url) !== null) return null;
  try {
    const origin = new URL((url as string).trim()).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export type PolicyHubTarget = { kind: "fs"; path: string } | { kind: "ssh"; host: string; path: string } | { kind: "http"; url: string };

/**
 * Whether a hub target may be used. Applied before anything is dialled (discover, probe, create, open).
 *
 * With a `hubAllowlist`, only an HTTPS/WSS hub whose origin matches an entry exactly is allowed. A folder or ssh hub has
 * no URL to match, so it is refused: the allowlist's purpose is to pin the places data may go, and a folder can be a
 * network mount while ssh reaches any host the user can. Without a `hubAllowlist` every target is allowed.
 */
export function hubTargetBlockReason(policy: SyncPolicyInput, target: PolicyHubTarget): string | null {
  const disabled = syncDisabledReason(policy);
  if (disabled) return disabled;
  if (!policy || !Array.isArray(policy.hubAllowlist)) return null;
  const allowed = policy.hubAllowlist.filter((entry) => entry !== "!none");
  const list = allowed.length ? allowed.join(", ") : "none";
  if (target.kind !== "http") return `blocked by administrator policy: sync hub allowlist permits only the listed HTTPS hubs (${list}); ${target.kind === "fs" ? "folder" : "ssh"} hubs are not permitted`;
  const origin = hubUrlOrigin(target.url);
  if (origin === null) return "blocked by administrator policy: sync hub URL could not be checked against the hub allowlist";
  if (allowed.includes(origin)) return null;
  return `blocked by administrator policy: sync hub ${origin} is not on the allowed hub list (allowed: ${list})`;
}

/** Hub IPC methods that carry a target (they establish a connection); the rest address an already-open session. */
const TARGET_METHODS: ReadonlySet<string> = new Set(["discover", "probe", "createVault", "open"]);

/**
 * Decision for one `hub-sync` request. `close` is always allowed so a session can end cleanly after a policy change;
 * everything else needs the hub provider to be allowed, and requests that carry a target also need the hub allowlist.
 */
export function hubRequestBlockReason(policy: SyncPolicyInput, request: { method: string; target?: unknown }): string | null {
  if (request.method === "close") return null;
  const provider = syncProviderBlockReason(policy, "hub");
  if (provider) return provider;
  if (TARGET_METHODS.has(request.method) && request.target && typeof request.target === "object") return hubTargetBlockReason(policy, request.target as PolicyHubTarget);
  return null;
}

/** iCloud container methods that only clean up local staged state; allowed even when sync is blocked. */
const ICLOUD_CLEANUP_METHODS: ReadonlySet<string> = new Set(["discardWrite"]);

export function icloudCallBlockReason(policy: SyncPolicyInput, method: string): string | null {
  if (ICLOUD_CLEANUP_METHODS.has(method)) return null;
  return syncProviderBlockReason(policy, "icloud");
}

/** Throws an Error naming the policy when the reason is non-null. For Electron `handle` channels, which reject on throw. */
export function assertSyncAllowed(reason: string | null): void {
  if (reason) throw new SyncPolicyError(reason);
}

export class SyncPolicyError extends Error {
  readonly code = SYNC_POLICY_BLOCKED;
  constructor(message: string) {
    super(message);
    this.name = "SyncPolicyError";
  }
}

/**
 * Decision for the provider-agnostic guarded-sync channels (`sync-owner-claim`, `sync-private-storage`,
 * `sync-local-apply`, `vault-sync-scan*`). They cannot tell which provider is calling, so they honour the kill switch and
 * a provider list that permits nothing; a per-provider narrowing is enforced where the provider is identifiable (the hub
 * and iCloud channels) and, advisory only, in the renderer.
 */
export function syncChannelBlockReason(policy: SyncPolicyInput): string | null {
  const disabled = syncDisabledReason(policy);
  if (disabled) return disabled;
  if (policy && Array.isArray(policy.providers) && !policy.providers.some((p) => p !== "!none")) {
    return "blocked by administrator policy: sync provider list permits no sync providers";
  }
  return null;
}

/** Short renderer-facing description of what the policy leaves for the settings UI. */
export function describeSyncPolicy(policy: SyncPolicyInput): { disabled: boolean; providers?: string[]; hubAllowlist?: string[] } {
  return {
    disabled: syncDisabledReason(policy) !== null,
    ...(policy && Array.isArray(policy.providers) ? { providers: policy.providers.filter((p) => p !== "!none") } : {}),
    ...(policy && Array.isArray(policy.hubAllowlist) ? { hubAllowlist: policy.hubAllowlist.filter((e) => e !== "!none") } : {}),
  };
}
