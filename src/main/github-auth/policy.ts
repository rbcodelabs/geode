import type { EffectivePolicy } from "../../renderer/policy-layering";

/**
 * Enforcement helpers for the managed `github` policy area (docs/adr/0054).
 *
 * Honest limits, repeated here because they bound every check in this file:
 * the renderer runs with nodeIntegration, so these checks only bind Geode's own
 * main-process code paths. They do not stop a user who has a personal `gh`
 * login or token in their environment, and they cannot stop a determined local
 * user from reading Geode's own keychain file.
 */

/** The `github` slice of the effective policy (machine + vault layers already merged). */
export type EffectiveGithubPolicy = EffectivePolicy["github"];

/** What the UI needs to know to show "managed by your administrator" instead of hiding a control. */
export interface GithubManagedControls {
  settingsLocked: boolean;
  /** `false`: sign-in is disabled (also blocks token issuance for an existing connection). */
  connect: boolean;
  /** `false`: the user may not remove the connection. */
  disconnect: boolean;
  /** An `allowedLogins` list restricts which account may be connected. */
  loginRestricted: boolean;
}

/** No policy: nothing locked, nothing restricted. */
export const UNMANAGED_GITHUB: GithubManagedControls = {
  settingsLocked: false,
  connect: true,
  disconnect: true,
  loginRestricted: false,
};

export const POLICY_BLOCK_PREFIX = "blocked by administrator policy: github";

export function managedControls(policy: EffectiveGithubPolicy | undefined): GithubManagedControls {
  if (!policy) return UNMANAGED_GITHUB;
  return {
    settingsLocked: policy.settingsLocked === true,
    connect: policy.connect !== false,
    disconnect: policy.disconnect !== false,
    loginRestricted: (policy.allowedLogins ?? []).length > 0,
  };
}

/**
 * Whether `login` satisfies every `allowedLogins` list (one list per policy
 * layer; the login must match an entry in each). An entry is an exact login or
 * a single leading `*` suffix pattern (`*@corp-emu`). GitHub logins are case
 * insensitive. A null/empty login never satisfies a restriction (fail closed:
 * we cannot show the account is allowed). The fail-closed `!none` sentinel
 * contains a character no login or pattern can, so it matches nothing.
 */
export function githubLoginAllowed(lists: readonly (readonly string[])[], login: string | null): boolean {
  if (lists.length === 0) return true;
  if (!login) return false;
  const candidate = login.toLowerCase();
  return lists.every((list) =>
    list.some((entry) => {
      const e = entry.toLowerCase();
      return e.startsWith("*") ? e.length > 1 && candidate.endsWith(e.slice(1)) : candidate === e;
    }),
  );
}

export function connectBlockedMessage(): string {
  return `${POLICY_BLOCK_PREFIX} (signing in to GitHub is disabled by your administrator).`;
}

export function disconnectBlockedMessage(): string {
  return `${POLICY_BLOCK_PREFIX} (your administrator does not allow removing the GitHub connection).`;
}

export function settingsLockedMessage(): string {
  return `${POLICY_BLOCK_PREFIX} (the GitHub settings are managed by your administrator).`;
}

export function loginRejectedMessage(login: string | null): string {
  const who = login ? `The GitHub account "${login}"` : "This GitHub account (its login could not be verified)";
  return `${POLICY_BLOCK_PREFIX}. ${who} is not permitted by your administrator. Sign in with an allowed account, or contact your administrator.`;
}

export function connectionBlockedMessage(login: string | null, reason: "connect" | "login"): string {
  if (reason === "connect") {
    return `${POLICY_BLOCK_PREFIX}. GitHub access is disabled by your administrator. Your connection is kept and will work again if the policy is relaxed.`;
  }
  return `${loginRejectedMessage(login)} Your connection is kept and will work again if the policy is relaxed.`;
}
