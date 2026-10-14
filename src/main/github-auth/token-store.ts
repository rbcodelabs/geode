import type { SecretStore } from "../secret-store";
import type { TokenSet } from "./device-flow";

const TOKEN_SECRET_ID = "github-app-auth";

export interface StoredAuth extends TokenSet {
  login: string | null;
  /** The App (client ID) that issued these tokens; a token is only valid for that App. */
  clientId: string | null;
}

/**
 * Persists the token set through the OS-keychain-backed `SecretStore`. Access
 * and refresh tokens are one JSON value under one id, so a refresh rotation is
 * a single atomic file replace: there is no window where the file holds a new
 * access token with a dead refresh token. Uses its own store file (not the
 * plugin-visible `secrets.json`) so plugins cannot read these tokens.
 */
export class GithubTokenStore {
  constructor(
    private readonly secrets: Pick<SecretStore, "get" | "set" | "delete" | "flush" | "isEncryptionAvailable">,
  ) {}

  isAvailable(): boolean {
    return this.secrets.isEncryptionAvailable();
  }

  load(): StoredAuth | null {
    const raw = this.secrets.get(TOKEN_SECRET_ID);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredAuth>;
      if (typeof parsed.accessToken !== "string") return null;
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken ?? null,
        accessTokenExpiresAt: parsed.accessTokenExpiresAt ?? null,
        refreshTokenExpiresAt: parsed.refreshTokenExpiresAt ?? null,
        login: parsed.login ?? null,
        clientId: typeof parsed.clientId === "string" ? parsed.clientId : null,
      };
    } catch {
      return null;
    }
  }

  async save(auth: StoredAuth): Promise<void> {
    this.secrets.set(TOKEN_SECRET_ID, JSON.stringify(auth));
    await this.secrets.flush();
  }

  async clear(): Promise<void> {
    this.secrets.delete(TOKEN_SECRET_ID);
    await this.secrets.flush();
  }
}
