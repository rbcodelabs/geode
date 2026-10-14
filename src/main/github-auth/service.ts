import {
  GithubAuthError,
  pollForToken,
  refreshTokens,
  requestDeviceCode,
  type DeviceCodeInfo,
} from "./device-flow";
import {
  appSettingsUrl,
  assessPermissions,
  fetchAppInfo,
  type GithubAppInfo,
  type GithubAppLookup,
  type PermissionReport,
} from "./app-info";
import { DEFAULT_GITHUB_CLIENT_ID, GITHUB_REVOKE_PAGE_URL, isRepoAllowed, type GithubAppSettings } from "./config";
import type { GithubHttp } from "./http";
import {
  checkRepoCoverage,
  fetchViewerLogin,
  GithubUnauthorizedError,
  listInstallations,
  type GithubInstallation,
  type RepoCoverage,
} from "./installations";
import type { GithubTokenStore, StoredAuth } from "./token-store";

/** Refresh this long before the access token actually expires. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** The App Geode is configured to use (not necessarily one the user has signed in to yet). */
export interface GithubActiveApp {
  slug: string;
  clientId: string;
}

export type GithubAuthState =
  | { state: "disconnected"; encryptionAvailable: boolean }
  | { state: "pending"; userCode: string; verificationUri: string; expiresAt: number }
  | { state: "connected"; login: string | null }
  | { state: "reauth_required"; message: string }
  | { state: "error"; message: string };

export type GithubAuthStatus = GithubAuthState & { app: GithubActiveApp };

/** Result of checking the configured App against GitHub: identity, settings link and permission diff. */
export interface GithubAppReport {
  slug: string;
  clientId: string;
  /** Display name when GitHub could be asked; null otherwise. */
  name: string | null;
  ownerLogin: string | null;
  settingsUrl: string;
  /** Set when the App could not be confirmed (not found, ID mismatch, offline). */
  problem: { code: "app_not_found" | "app_mismatch" | "unavailable"; message: string } | null;
  permissions: PermissionReport | null;
}

export interface GithubAuthDeps {
  http: GithubHttp;
  store: GithubTokenStore;
  /** Read per call so the active App can change (config edit, different vault) while running. */
  settings: () => GithubAppSettings;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class GithubAuthService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private appLookup: { slug: string; at: number; result: GithubAppLookup } | null = null;
  private pending: { device: DeviceCodeInfo; expiresAt: number; abort: AbortController; done: Promise<void> } | null = null;
  private failure: { state: "error" | "reauth_required"; message: string } | null = null;
  private refreshing: Promise<StoredAuth> | null = null;

  constructor(private readonly deps: GithubAuthDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private get app(): GithubActiveApp {
    const { appSlug, clientId } = this.deps.settings();
    return { slug: appSlug, clientId };
  }

  /**
   * The stored tokens, but only if the configured App still matches the one
   * that issued them. Tokens from another App are dropped (never sent on), and
   * the user is asked to reconnect. Tokens saved before the client ID was
   * recorded came from the default App unless proven otherwise.
   */
  private loadMatching(): StoredAuth | null {
    const stored = this.deps.store.load();
    if (!stored) return null;
    const wanted = this.deps.settings().clientId;
    if ((stored.clientId ?? DEFAULT_GITHUB_CLIENT_ID) === wanted) return stored;
    this.failure = {
      state: "reauth_required",
      message: "The GitHub App Geode is configured to use has changed. Connect GitHub again to use the new App.",
    };
    void this.deps.store.clear();
    return null;
  }

  getStatus(): GithubAuthStatus {
    return { ...this.rawStatus(), app: this.app };
  }

  private rawStatus(): GithubAuthState {
    if (this.pending) {
      return {
        state: "pending",
        userCode: this.pending.device.userCode,
        verificationUri: this.pending.device.verificationUri,
        expiresAt: this.pending.expiresAt,
      };
    }
    const stored = this.loadMatching();
    if (stored) return { state: "connected", login: stored.login };
    if (this.failure) return this.failure;
    return { state: "disconnected", encryptionAvailable: this.deps.store.isAvailable() };
  }

  /**
   * Begin the device flow. Resolves with the code to show the user as soon as
   * GitHub issues it; polling continues in the background. `waitForSignIn()`
   * resolves when it finishes (tests use it; the UI polls `getStatus`).
   */
  async startSignIn(opts: { confirmExtraPermissions?: boolean } = {}): Promise<DeviceCodeInfo> {
    if (!this.deps.store.isAvailable()) {
      throw new GithubAuthError("unexpected", "No OS keychain is available, so GitHub tokens cannot be stored safely.");
    }
    const { clientId } = this.deps.settings();
    // Verify the App before asking GitHub for a code, so a wrong slug/client ID
    // or missing permission is explained instead of surfacing as a bare failure.
    const report = await this.getAppReport(true);
    if (report.problem && report.problem.code !== "unavailable") {
      throw new GithubAuthError(report.problem.code, report.problem.message, report.settingsUrl);
    }
    if (report.permissions?.extra.length && !opts.confirmExtraPermissions) {
      const names = report.permissions.extra.map((e) => `${e.permission} (${e.level})`).join(", ");
      throw new GithubAuthError(
        "confirmation_required",
        `This GitHub App grants more than Geode needs: ${names}. Agent threads will hold these powers. Confirm to connect anyway.`,
        report.settingsUrl,
      );
    }
    this.cancelPending();
    this.failure = null;
    const device = await requestDeviceCode(this.deps.http, clientId, report.settingsUrl);
    const abort = new AbortController();
    const done = this.completeSignIn(device, abort.signal, clientId);
    this.pending = { device, expiresAt: this.now() + device.expiresIn * 1000, abort, done };
    return device;
  }

  /** Identity + permission check of the configured App. `fresh` bypasses the 60s cache. */
  async getAppReport(fresh = false): Promise<GithubAppReport> {
    const { appSlug, clientId } = this.deps.settings();
    let cached = this.appLookup;
    if (fresh || !cached || cached.slug !== appSlug || this.now() - cached.at > 60_000) {
      cached = { slug: appSlug, at: this.now(), result: await fetchAppInfo(this.deps.http, appSlug) };
      this.appLookup = cached;
    }
    const lookup = cached.result;
    const app: GithubAppInfo | null = lookup.kind === "found" ? lookup.app : null;
    const settingsUrl = appSettingsUrl(app, appSlug);
    const base = { slug: appSlug, clientId, name: app?.name ?? null, ownerLogin: app?.ownerLogin ?? null, settingsUrl };
    if (lookup.kind === "not_found") {
      return { ...base, permissions: null, problem: { code: "app_not_found", message: `No GitHub App with the slug "${appSlug}" exists. Check github.appSlug.` } };
    }
    if (lookup.kind === "unavailable") {
      return { ...base, permissions: null, problem: { code: "unavailable", message: lookup.message } };
    }
    if (lookup.app.clientId && lookup.app.clientId !== clientId) {
      return {
        ...base,
        permissions: null,
        problem: {
          code: "app_mismatch",
          message: `The client ID ${clientId} does not belong to the GitHub App "${appSlug}" (its client ID is ${lookup.app.clientId}). Fix github.clientId or github.appSlug.`,
        },
      };
    }
    return { ...base, permissions: assessPermissions(lookup.app.permissions), problem: null };
  }

  waitForSignIn(): Promise<void> {
    return this.pending?.done ?? Promise.resolve();
  }

  private async completeSignIn(device: DeviceCodeInfo, signal: AbortSignal, clientId: string): Promise<void> {
    try {
      const tokens = await pollForToken({
        http: this.deps.http,
        clientId,
        device,
        sleep: this.sleep,
        now: this.now,
        signal,
      });
      if (signal.aborted) return;
      let login: string | null = null;
      try {
        login = await fetchViewerLogin(this.deps.http, tokens.accessToken);
      } catch {
        // The login is cosmetic; the tokens are still valid.
      }
      await this.deps.store.save({ ...tokens, login, clientId });
    } catch (error) {
      if (!signal.aborted) this.failure = { state: "error", message: (error as Error).message };
    } finally {
      if (this.pending?.abort.signal === signal) this.pending = null;
    }
  }

  private cancelPending(): void {
    this.pending?.abort.abort();
    this.pending = null;
  }

  /**
   * A valid access token, refreshing (and persisting the rotated refresh token)
   * when it is near expiry. Callers hand this to a thread/terminal as GH_TOKEN
   * on demand; it is never injected globally. Throws GithubAuthError with
   * `reauth_required` when the user must reconnect.
   */
  async getAccessToken(repoFullName?: string): Promise<string> {
    if (repoFullName && !isRepoAllowed(this.deps.settings().allow, repoFullName)) {
      throw new GithubAuthError("not_allowed", `${repoFullName} is outside the repositories Geode is allowed to reach (github.allowedOwners / allowedRepos).`);
    }
    const stored = this.loadMatching();
    if (!stored) throw new GithubAuthError("reauth_required", "GitHub is not connected.");
    if (!this.isNearExpiry(stored)) return stored.accessToken;
    return (await this.refresh(stored)).accessToken;
  }

  private isNearExpiry(auth: StoredAuth): boolean {
    return auth.accessTokenExpiresAt != null && this.now() >= auth.accessTokenExpiresAt - REFRESH_SKEW_MS;
  }

  private refresh(stored: StoredAuth): Promise<StoredAuth> {
    // Single-flight: refresh tokens are one-shot, so two concurrent refreshes
    // would burn the token and log the user out.
    this.refreshing ??= this.doRefresh(stored).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(stored: StoredAuth): Promise<StoredAuth> {
    if (!stored.refreshToken) return this.requireReauth("GitHub sign-in expired. Connect GitHub again.");
    try {
      const tokens = await refreshTokens(this.deps.http, stored.clientId ?? this.deps.settings().clientId, stored.refreshToken, this.now());
      const next: StoredAuth = { ...tokens, login: stored.login, clientId: stored.clientId ?? this.deps.settings().clientId };
      await this.deps.store.save(next);
      return next;
    } catch (error) {
      if (error instanceof GithubAuthError && error.code === "reauth_required") {
        return this.requireReauth(error.message);
      }
      throw error;
    }
  }

  private async requireReauth(message: string): Promise<never> {
    await this.deps.store.clear();
    this.failure = { state: "reauth_required", message };
    throw new GithubAuthError("reauth_required", message);
  }

  /** Run an API call, refreshing once if GitHub rejects the token early. */
  private async withToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    const token = await this.getAccessToken();
    try {
      return await call(token);
    } catch (error) {
      if (!(error instanceof GithubUnauthorizedError)) throw error;
      const stored = this.loadMatching();
      if (!stored) throw error;
      return call((await this.refresh(stored)).accessToken);
    }
  }

  /** Installations the App can reach, narrowed to what the allowlist permits. */
  async listAccess(): Promise<GithubInstallation[]> {
    const all = await this.withToken((token) => listInstallations(this.deps.http, token));
    const { allow } = this.deps.settings();
    if (!allow.length) return all;
    return all
      .map((inst) => ({ ...inst, repositories: inst.repositories.filter((r) => isRepoAllowed(allow, r.fullName)) }))
      .filter((inst) => inst.repositories.length > 0);
  }

  async checkRepo(repoFullName: string): Promise<RepoCoverage> {
    const { appSlug, allow } = this.deps.settings();
    if (!isRepoAllowed(allow, repoFullName)) return checkRepoCoverage([], repoFullName, appSlug, allow);
    return checkRepoCoverage(await this.listAccess(), repoFullName, appSlug, allow);
  }

  /**
   * Forget the tokens locally. The revoke API needs a client secret we do not
   * have, so the user is pointed at GitHub's settings page to revoke there.
   */
  async disconnect(): Promise<{ revokeUrl: string }> {
    this.cancelPending();
    this.failure = null;
    await this.deps.store.clear();
    return { revokeUrl: GITHUB_REVOKE_PAGE_URL };
  }
}
