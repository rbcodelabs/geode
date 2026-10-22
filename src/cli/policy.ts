/**
 * CLI-side policy adapter. The only `src/cli/` module that may import `src/policy-node/index.ts`
 * (audit rule 6); the decisions themselves are pure and live in `./policy-decisions`.
 *
 * Policy is evaluated FRESH on every invocation (no cache, no watcher) and fails OPEN when the
 * machine file or the vault file is missing or invalid (docs/adr/0002). Layering is the app's own
 * `resolveEffectivePolicy`, so `vaultPolicy: "ignore"` in the machine file is honoured.
 *
 * HONESTY: this is a guardrail on the shipped binary, not a security boundary (docs/adr/0055).
 */

import { resolve as resolvePath } from "node:path";
import { loadEffectivePolicy, type EffectivePolicyResult } from "../policy-node/index";
import {
  decideListenAddress, decideSyncInvocation, isScheduledInvocation, POLICY_STATUS,
  type CliPolicyView, type PolicyBlock, type SyncInvocation,
} from "./policy-decisions";
import type { CliOutcome } from "./output";

export { POLICY_STATUS, isScheduledInvocation };
export type { PolicyBlock };

/**
 * Load the effective policy for `root` (or the machine layer alone when `root` is null, as for
 * `sync serve`, which has no vault). Never throws: any failure is fail-open (no restrictions).
 */
export function loadCliPolicy(root: string | null, env: NodeJS.ProcessEnv): { view: CliPolicyView; result: EffectivePolicyResult | null } {
  try {
    const result = loadEffectivePolicy(root === null ? null : resolvePath(root), env);
    return { view: result.effective, result };
  } catch (error) {
    console.error("geode-wiki: could not evaluate managed policy; ignoring it (fail open).", error);
    return { view: { sync: { enabled: true }, daemons: { allowSchedule: true, allowServe: true } }, result: null };
  }
}

/** The refusal as a normal CLI outcome: same envelope, status `blocked-by-policy`, exit 6. */
export function policyOutcome(command: string, blocked: PolicyBlock, result: EffectivePolicyResult | null): CliOutcome {
  const layers = result?.provenance[blocked.setting];
  return {
    command,
    status: POLICY_STATUS,
    result: { message: blocked.message, policy: blocked.feature, setting: blocked.setting, ...(layers ? { layers } : {}) },
    lines: [`${POLICY_STATUS}  ${blocked.message}`],
  };
}

/** Evaluate policy for one `sync` invocation. `null` means proceed. */
export function checkSyncPolicy(call: SyncInvocation, root: string | null, env: NodeJS.ProcessEnv, command: string): CliOutcome | null {
  const { view, result } = loadCliPolicy(root, env);
  const blocked = decideSyncInvocation(view, { ...call, scheduled: call.scheduled ?? (call.sub === "run" && isScheduledInvocation(env)) });
  return blocked ? policyOutcome(command, blocked, result) : null;
}

/** Evaluate policy for an `--http` listen bind. `null` means proceed. */
export function checkListenPolicy(host: string, env: NodeJS.ProcessEnv, command: string): CliOutcome | null {
  const { view, result } = loadCliPolicy(null, env);
  const blocked = decideListenAddress(view, host);
  return blocked ? policyOutcome(command, blocked, result) : null;
}
