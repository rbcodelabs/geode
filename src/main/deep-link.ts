import { parseGeodeDeepLink, type GeodeDeepLink } from "../shared/deep-link-parse";
export { parseGeodeDeepLink, type GeodeDeepLink };

/** Matches an argv entry that is one of `DEEP_LINK_PROTOCOLS`. */
const DEEP_LINK_ARGV = /^(?:geode|obsidian):\/\//i;

/**
 * Whether Geode should claim the OS-level `obsidian://` scheme on launch.
 *
 * Claiming is deliberately non-hijacking. `app.setAsDefaultProtocolClient`
 * rewrites the OS default handler outright (on macOS it calls
 * `LSSetDefaultHandlerForURLScheme`), so registering unconditionally would
 * silently steal every `obsidian://` link from a real Obsidian install on the
 * same machine — including ones Geode cannot service, since Geode only
 * dispatches to plugins that registered a handler. So we claim the scheme
 * only when nothing else currently answers it, or when the current answer is
 * already Geode (the steady state after a first successful claim).
 *
 * @param currentHandler `app.getApplicationNameForProtocol("obsidian://")`,
 *   which is the empty string when no application is registered.
 * @param force Escape hatch (`GEODE_CLAIM_OBSIDIAN_PROTOCOL=1`) for users who
 *   deliberately want Geode to take the scheme over from Obsidian.
 */
export function shouldClaimObsidianProtocol(currentHandler: string, force = false): boolean {
  if (force) return true;
  const name = currentHandler.trim().toLowerCase().replace(/\.app$/, "");
  return name === "" || name === "geode";
}

export class DeepLinkDispatcher {
  private pending: GeodeDeepLink[] = [];
  private send: ((link: GeodeDeepLink) => void) | null = null;

  accept(value: string): boolean {
    const link = parseGeodeDeepLink(value);
    if (!link) return false;
    if (this.send) this.send(link);
    else this.pending.push(link);
    return true;
  }

  acceptArgv(argv: string[]): boolean {
    const value = argv.find((arg) => DEEP_LINK_ARGV.test(arg));
    return value ? this.accept(value) : false;
  }

  attach(send: (link: GeodeDeepLink) => void): void {
    this.send = send;
    for (const link of this.pending.splice(0)) send(link);
  }
}
