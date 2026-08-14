/**
 * Enterprise-managed plugin policy. An IT admin drops a JSON file at a
 * fixed, admin/root-owned OS path (see `policyFilePath()` in
 * `src/main/main.ts`); Geode reads it and refuses to enable blocked
 * plugins. See `docs/adr/0002-enterprise-plugin-policy.md` for the full
 * design.
 *
 * This module is deliberately pure (no IO, no Electron/DOM imports) so it
 * can be unit-tested directly and shared, unmodified, between the main
 * process (which reads the file off disk) and the renderer (which enforces
 * it in `PluginManager`). `bundle: true` in `esbuild.config.mjs` builds
 * `main.ts` and `app.ts` as two independent bundles from their own module
 * graphs, so importing this file from `src/main/main.ts` does not pull any
 * renderer/DOM code into the main-process build — only what this file
 * itself imports, which is nothing.
 */

/** Plugin manifest `id` values, per `plugin-manifest.ts`'s `ID_RE`. */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface ManagedPolicy {
  policyVersion: 1;
  plugins?: {
    mode: "allowlist" | "blocklist";
    ids: string[];
  };
}

/**
 * Parse and validate an already-`JSON.parse`d policy document. Never
 * throws — any structural problem (missing/unknown `policyVersion`,
 * invalid `mode`, non-array `ids`) causes the whole document, or just the
 * offending sub-section, to be treated as absent ("fail open"). A single
 * invalid entry inside `ids` is skipped with a logged warning rather than
 * invalidating the rest of the list.
 *
 * Returns `null` if the document is not usable at all.
 */
export function validatePolicy(raw: unknown): ManagedPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.error("Managed policy: file does not contain a JSON object; ignoring (fail open).");
    return null;
  }
  const obj = raw as Record<string, unknown>;

  if (obj.policyVersion !== 1) {
    console.error(
      `Managed policy: missing or unrecognized policyVersion (${JSON.stringify(
        obj.policyVersion
      )}); ignoring (fail open).`
    );
    return null;
  }

  const policy: ManagedPolicy = { policyVersion: 1 };

  if (obj.plugins !== undefined) {
    const plugins = obj.plugins;
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
      console.error("Managed policy: \"plugins\" is present but not an object; ignoring plugins policy.");
    } else {
      const p = plugins as Record<string, unknown>;
      if (p.mode !== "allowlist" && p.mode !== "blocklist") {
        console.error(
          `Managed policy: "plugins.mode" must be "allowlist" or "blocklist", got ${JSON.stringify(
            p.mode
          )}; ignoring plugins policy.`
        );
      } else if (!Array.isArray(p.ids)) {
        console.error('Managed policy: "plugins.ids" must be an array; ignoring plugins policy.');
      } else {
        const ids: string[] = [];
        for (const id of p.ids) {
          if (typeof id === "string" && ID_RE.test(id)) {
            ids.push(id);
          } else {
            console.warn(`Managed policy: skipping invalid plugin id ${JSON.stringify(id)} in "plugins.ids".`);
          }
        }
        policy.plugins = { mode: p.mode, ids };
      }
    }
  }

  return policy;
}

/**
 * Whether plugin `id` is blocked under `policy`. `null` policy (missing
 * file, malformed, fail-open) or a policy with no `plugins` key never
 * blocks anything.
 */
export function isPluginBlocked(policy: ManagedPolicy | null, id: string): boolean {
  const p = policy?.plugins;
  if (!p) return false;
  const listed = p.ids.includes(id);
  return p.mode === "allowlist" ? !listed : listed;
}
