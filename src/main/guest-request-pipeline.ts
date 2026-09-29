/**
 * The single `onBeforeSendHeaders` registration Electron allows per session.
 *
 * ## Why this file exists
 *
 * `session.webRequest.onBeforeSendHeaders` accepts only ONE listener per
 * session — registering a second SILENTLY REPLACES the first, with no error
 * and no warning. Before this file, `guest-fingerprint.ts`'s client-hint
 * logic was the only thing that ever called it, so the footgun was latent.
 * It stops being latent the moment a second concern (e.g. secret-backed
 * request-header rules for the agent browser) needs to touch outgoing
 * request headers on the same guest sessions.
 *
 * This module is now the ONLY legal place in Geode to register
 * `onBeforeSendHeaders` on a guest session. Every concern that needs to add,
 * remove, or inspect request headers becomes a `HeaderStage` appended to the
 * array passed to `attachGuestRequestPipeline` from `main.ts`'s single
 * `session-created` handler — never a second, independent
 * `webRequest.onBeforeSendHeaders(...)` call anywhere else. See
 * `guest-fingerprint.ts`'s `createClientHintStage` for the first stage, and
 * `tests/unit/guest-request-pipeline.test.ts` for a static guard that no
 * second call site creeps back in.
 */

/** The request under consideration and the mutable header set stages share. */
export interface HeaderStageContext {
  readonly details: Electron.OnBeforeSendHeadersListenerDetails;
  /**
   * Mutate in place. Starts as a shallow copy of `details.requestHeaders`, so
   * a stage can read what an earlier stage already added without reaching
   * back into `details`.
   */
  readonly headers: Record<string, string>;
}

/**
 * One concern's contribution to a request's outgoing headers. Mutate
 * `ctx.headers` in place and return `true` iff anything changed, so the
 * pipeline only rewrites the request's headers when at least one stage
 * actually touched them — matching the pre-pipeline behavior of leaving a
 * request completely untouched (`callback({})`) when there was nothing to add.
 */
export type HeaderStage = (ctx: HeaderStageContext) => boolean;

const GUEST_REQUEST_URL_FILTER: Electron.WebRequestFilter = { urls: ["http://*/*", "https://*/*"] };

/**
 * Register a session's one-and-only `onBeforeSendHeaders` listener, running
 * `stages` in order over a header set shared by reference across all of them.
 *
 * Registers nothing when `stages` is empty — the same "nothing to do, don't
 * even attach" behavior the pre-pipeline `attachGuestClientHints` had. As of
 * P1 (`browser-header-rules.ts`'s rule and scrub stages), `main.ts` pushes
 * those two stages onto every session's `stages` array unconditionally — each
 * is a cheap no-op unless its session is bound to the agent browser — so in
 * practice `stages` is never empty and this check no longer skips
 * registration for any real session. It remains as the correct default for a
 * caller that passes no stages at all (e.g. a unit test).
 */
export function attachGuestRequestPipeline(target: Electron.Session, stages: readonly HeaderStage[]): void {
  if (stages.length === 0) return;
  target.webRequest.onBeforeSendHeaders(GUEST_REQUEST_URL_FILTER, (details, callback) => {
    const headers: Record<string, string> = { ...details.requestHeaders };
    let changed = false;
    for (const stage of stages) {
      if (stage({ details, headers })) changed = true;
    }
    callback(changed ? { requestHeaders: headers } : {});
  });
}
