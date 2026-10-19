/**
 * Node/undici `fetch` rejects with a bare `TypeError: fetch failed`; the real
 * reason (ENOTFOUND, ETIMEDOUT, a certificate error...) hides in `error.cause`.
 * Format the error with that chain so messages say why, e.g.
 * "fetch failed (ENOTFOUND api.github.com)".
 */
const MAX_CAUSE_DEPTH = 5;

function causeDetail(cause: unknown): string | null {
  if (cause && typeof cause === "object") {
    const c = cause as { code?: unknown; hostname?: unknown; message?: unknown };
    const code = typeof c.code === "string" ? c.code : null;
    const host = typeof c.hostname === "string" ? c.hostname : null;
    if (code) return host ? `${code} ${host}` : code;
    return typeof c.message === "string" && c.message ? c.message : null;
  }
  return typeof cause === "string" && cause ? cause : null;
}

export function describeNetworkError(error: unknown): string {
  const base = error instanceof Error ? error.message || error.name : typeof error === "string" ? error : String(error);
  const details: string[] = [];
  let cause: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause != null && depth < MAX_CAUSE_DEPTH; depth++) {
    const detail = causeDetail(cause);
    if (detail && detail !== base && !details.includes(detail)) details.push(detail);
    cause = typeof cause === "object" ? (cause as { cause?: unknown }).cause : undefined;
  }
  return details.length ? `${base} (${details.join(": ")})` : base;
}
