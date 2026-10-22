/**
 * Pure decisions for `geode-wiki` under managed policy (docs/adr/0055-cli-policy.md). No IO, no
 * imports from `src/`: callers hand in the already-resolved effective policy, so these functions are
 * trivially unit-testable and `src/cli/policy.ts` is the only place that loads files.
 *
 * HONESTY: `geode-wiki` is a user-runnable build artifact. These checks are a guardrail on the
 * shipped binary, NOT a security boundary. A user who can run arbitrary Node code, edit the bundle,
 * or write to the machine policy file's directory is not stopped by any of this.
 */

import { isIP } from "node:net";

/** The status a policy refusal carries in the `--json` envelope. Maps to exit code 6 (`EXIT.policy`). */
export const POLICY_STATUS = "blocked-by-policy";

/** The slice of the effective policy the CLI cares about (structurally what `EffectivePolicy` provides). */
export interface CliPolicyView {
  readonly sync: { readonly enabled: boolean };
  readonly daemons: {
    readonly allowSchedule: boolean;
    readonly allowServe: boolean;
    readonly allowedListenAddresses?: readonly string[];
  };
}

/** A refusal. `feature` is the policy area named to the user: "sync" or "daemons". */
export interface PolicyBlock {
  readonly feature: "sync" | "daemons";
  /** Dotted policy path that produced the refusal, e.g. "sync.enabled". */
  readonly setting: string;
  /** Human message, starts with "blocked by administrator policy: <feature>". */
  readonly message: string;
}

const block = (feature: PolicyBlock["feature"], setting: string, detail: string): PolicyBlock => ({
  feature, setting, message: `blocked by administrator policy: ${feature} (${setting}) - ${detail}`,
});

/** What the invocation is, as far as policy cares. */
export interface SyncInvocation {
  /** `init`, `run`, `serve`, `schedule`, ... */
  readonly sub: string;
  /** `install`, `uninstall`, ... for `schedule`. */
  readonly action?: string;
  /** True when this `sync run` was started by an installed launchd/systemd unit. See `isScheduledInvocation`. */
  readonly scheduled?: boolean;
}

/**
 * Subcommands that touch a vault root and/or the hub: blocked when `sync.enabled` is false.
 * Deliberately NOT gated, so a user can inspect and clean up: `status` and `conflicts` (local state
 * only, never the store), `schedule print` (writes nothing) and `schedule status|uninstall` (a
 * previously installed job must stay removable).
 */
const SYNC_GATED = new Set(["init", "preview", "run", "resolve", "gc", "serve"]);

/**
 * Decide whether a `sync` invocation may proceed. `null` means allowed.
 *
 * `sync.enabled=false` blocks every subcommand that touches a root or serves a hub.
 * `daemons.allowSchedule=false` blocks `schedule install` (with or without `--activate`) and a
 * `sync run` that an installed unit started, which is what makes ALREADY-INSTALLED schedules stop.
 * `daemons.allowServe=false` blocks `serve` (both stdio and `--http`).
 */
export function decideSyncInvocation(policy: CliPolicyView, call: SyncInvocation): PolicyBlock | null {
  const { sub, action } = call;
  const gated = SYNC_GATED.has(sub) || (sub === "schedule" && action === "install");
  if (gated && !policy.sync.enabled) {
    return block("sync", "sync.enabled", "sync is disabled, so `geode-wiki sync " + (sub === "schedule" ? `schedule ${action}` : sub) + "` will not run");
  }
  if (sub === "schedule" && action === "install" && !policy.daemons.allowSchedule) {
    return block("daemons", "daemons.allowSchedule", "installing or activating a scheduled sync is not allowed (`schedule uninstall` still works)");
  }
  if (sub === "run" && call.scheduled === true && !policy.daemons.allowSchedule) {
    return block("daemons", "daemons.allowSchedule", "scheduled sync runs are not allowed; this installed schedule did nothing (remove it with `geode-wiki sync schedule uninstall`)");
  }
  if (sub === "serve" && !policy.daemons.allowServe) {
    return block("daemons", "daemons.allowServe", "serving a hub is not allowed");
  }
  return null;
}

/**
 * Best-effort detection that this process was started by an installed schedule. The scheduled
 * command line is fixed by ADR 0025 and must not gain flags, and units installed before this policy
 * existed cannot be changed, so the only signal is the service manager's environment:
 *  - systemd sets `INVOCATION_ID` for every unit it starts (and `JOURNAL_STREAM` when logging);
 *  - launchd sets `XPC_SERVICE_NAME` to the job label, which for our units starts with
 *    `com.geode.wiki-sync.`.
 * This is a heuristic, deliberately: it is spoofable (a user can unset it) and a hand-run
 * `systemd-run` of `sync run` looks scheduled. Both are acceptable for a guardrail.
 */
export function isScheduledInvocation(env: NodeJS.ProcessEnv): boolean {
  if (typeof env.INVOCATION_ID === "string" && env.INVOCATION_ID !== "") return true;
  return typeof env.XPC_SERVICE_NAME === "string" && env.XPC_SERVICE_NAME.startsWith("com.geode.wiki-sync.");
}

/* ------------------------------------------------------------ listen address */

const LOOPBACK_ALIASES = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

/** `[::1]` -> `::1`, lower-cased, trimmed. Does not resolve anything. */
function normalizeHost(host: string): string {
  return host.trim().replace(/^\[|\]$/g, "").toLowerCase();
}

const isWildcard = (host: string) => host === "" || host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0";

/**
 * Canonical form used for comparison. IPv6 literals are expanded by the URL parser so `::0001`,
 * `0:0:0:0:0:0:0:1` and `::1` compare equal; IPv4 literals and DNS names are compared as typed.
 */
function canonical(host: string): string {
  if (isIP(host) === 6) {
    try { return normalizeHost(new URL(`http://[${host}]/`).hostname); } catch { return host; }
  }
  return host;
}

/**
 * Decide whether `sync serve --http --listen <host>:<port>` may bind `host`. `null` means allowed.
 *
 * Rule (documented in docs/design/enterprise-controls.md and ADR 0055):
 *  - No `allowedListenAddresses` in the effective policy: no restriction.
 *  - Otherwise the host is matched TEXTUALLY against the list after normalisation (brackets removed,
 *    lower-cased, IPv6 literals canonicalised). DNS names are never resolved: a name passes only when
 *    it is itself listed, so `corp.example` cannot be used to reach an address the admin did not list.
 *  - The loopback aliases `127.0.0.1`, `::1`, `localhost` (and `::ffff:127.0.0.1`) are one class: listing
 *    any of them allows all of them, because `localhost` binds to either family depending on the resolver.
 *  - The wildcards `0.0.0.0` and `::` (and an empty host) bind every interface, so they pass only if
 *    the admin listed that exact wildcard. Listing `127.0.0.1` never admits them.
 *  - An empty list allows nothing.
 */
export function decideListenAddress(policy: CliPolicyView, host: string): PolicyBlock | null {
  const list = policy.daemons.allowedListenAddresses;
  if (list === undefined) return null;
  const want = canonical(normalizeHost(host));
  const entries = list.map((entry) => canonical(normalizeHost(entry)));
  const allowed = isWildcard(want)
    ? entries.includes(want) || (want === "" && entries.includes("0.0.0.0"))
    : LOOPBACK_ALIASES.has(want)
      ? entries.some((entry) => LOOPBACK_ALIASES.has(entry))
      : entries.includes(want);
  if (allowed) return null;
  const shown = host === "" ? "(all interfaces)" : host;
  return block("daemons", "daemons.allowedListenAddresses", `listening on ${shown} is not allowed; allowed addresses: ${list.length ? list.join(", ") : "(none)"}`);
}
