import {
  GithubAuthError,
  pollForToken,
  refreshTokens,
  requestDeviceCode,
  type DeviceCodeInfo,
} from "./device-flow";
import { GITHUB_REVOKE_PAGE_URL } from "./config";
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

export type GithubAuthStatus =
  | { state: "disconnected"; encryptionAvailable: boolean }
  | { state: "pending"; userCode: string; verificationUri: string; expiresAt: number }
  | { state: "connected"; login: string | null }
  | { state: "reauth_required"; message: string }
  | { state: "error"; message: string };

export interface GithubAuthDeps {
  http: GithubHttp;
  store: GithubTokenStore;
  clientId: string;
  appSlug: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class GithubAuthService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private pending: { device: DeviceCodeInfo; expiresAt: number; abort: AbortController; done: Promise<void> } | null = null;
  private failure: { state: "error" | "reauth_required"; message: string } | null = null;
  private refreshing: Promise<StoredAuth> | null = null;

  constructor(private readonly deps: GithubAuthDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  getStatus(): GithubAuthStatus {
    if (this.pending) {
      return {
        state: "pending",
        userCode: this.pending.device.userCode,
        verificationUri: this.pending.device.verificationUri,
        expiresAt: this.pending.expiresAt,
      };
    }
    const stored = this.deps.store.load();
    if (stored) return { state: "connected", login: stored.login };
    if (this.failure) return this.failure;
    return { state: "disconnected", encryptionAvailable: this.deps.store.isAvailable() };
  }

  /**
   * Begin the device flow. Resolves with the code to show the user as soon as
   * GitHub issues it; polling continues in the background. `waitForSignIn()`
   * resolves when it finishes (tests use it; the UI polls `getStatus`).
   */
  async startSignIn(): Promise<DeviceCodeInfo> {
    if (!this.deps.store.isAvailable()) {
      throw new GithubAuthError("unexpected", "No OS keychain is available, so GitHub tokens cannot be stored safely.");
    }
    this.cancelPending();
    this.failure = null;
    const device = await requestDeviceCode(this.deps.http, this.deps.clientId);
    const abort = new AbortController();
    const done = this.completeSignIn(device, abort.signal);
    this.pending = { device, expiresAt: this.now() + device.expiresIn * 1000, abort, done };
    return device;
  }

  waitForSignIn(): Promise<void> {
    return this.pending?.done ?? Promise.resolve();
  }

  private async completeSignIn(device: DeviceCodeInfo, signal: AbortSignal): Promise<void> {
    try {
      const tokens = await pollForToken({
        http: this.deps.http,
        clientId: this.deps.clientId,
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
      await this.deps.store.save({ ...tokens, login });
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
  async getAccessToken(): Promise<string> {
    const stored = this.deps.store.load();
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
      const tokens = await refreshTokens(this.deps.http, this.deps.clientId, stored.refreshToken, this.now());
      const next: StoredAuth = { ...tokens, login: stored.login };
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
      const stored = this.deps.store.load();
      if (!stored) throw error;
      return call((await this.refresh(stored)).accessToken);
    }
  }

  listAccess(): Promise<GithubInstallation[]> {
    return this.withToken((token) => listInstallations(this.deps.http, token));
  }

  async checkRepo(repoFullName: string): Promise<RepoCoverage> {
    return checkRepoCoverage(await this.listAccess(), repoFullName, this.deps.appSlug);
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
