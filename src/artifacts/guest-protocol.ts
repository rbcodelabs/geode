/**
 * Channel names shared by the artifact guest preload and the renderer-side
 * vault bridge. Kept dependency-free so the sandboxed preload bundle stays tiny.
 */
export const ARTIFACT_VAULT_QUERY_CHANNEL = "geode-artifact:query";
export const ARTIFACT_VAULT_RESPONSE_CHANNEL = "geode-artifact:response";
export const ARTIFACT_VAULT_CHANGE_CHANNEL = "geode-artifact:change";
/** Guest-side timeout for a query that the host never answers. */
export const ARTIFACT_VAULT_QUERY_TIMEOUT_MS = 15_000;
