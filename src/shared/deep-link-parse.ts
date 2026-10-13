// Pure deep-link parsing shared by the Electron main process and the mobile
// renderer (which must not import src/main/*).
export interface GeodeDeepLink {
  action: string;
  params: Record<string, string>;
}

/**
 * URL schemes Geode answers deep links on.
 *
 * `obsidian:` is accepted alongside Geode's own scheme because hosted
 * Obsidian plugins mint `obsidian://<action>?…` links to drive
 * `Plugin.registerObsidianProtocolHandler` — Claude Threads' mobile pairing
 * QR codes are `obsidian://pair?roomId=…`. The action/parameter shape is
 * identical for both schemes, so the same parse serves each.
 *
 * Accepting the scheme here is separate from *claiming* it at the OS level;
 * see `shouldClaimObsidianProtocol`.
 */
const DEEP_LINK_PROTOCOLS = new Set(["geode:", "obsidian:"]);

export function parseGeodeDeepLink(value: string): GeodeDeepLink | null {
  try {
    const url = new URL(value);
    // `URL` lower-cases the scheme, so the set membership test is exact.
    if (!DEEP_LINK_PROTOCOLS.has(url.protocol) || !url.hostname) return null;
    const action = decodeURIComponent(url.hostname);
    return {
      action,
      params: { ...Object.fromEntries(url.searchParams), action },
    };
  } catch {
    return null;
  }
}
