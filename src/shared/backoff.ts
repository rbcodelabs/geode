/** Exponential backoff with a cap and optional jitter. Pure; the RNG is injectable for tests. */
export type BackoffJitter = "none" | "equal" | "full";
export interface BackoffOptions { baseMs: number; maxMs: number; jitter?: BackoffJitter; random?: () => number }

/** Delay before retry number `attempt` (0-based): min(maxMs, baseMs * 2^attempt), then jittered. */
export function nextDelay(attempt: number, { baseMs, maxMs, jitter = "equal", random = Math.random }: BackoffOptions): number {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(0, attempt), 50));
  if (jitter === "full") return random() * raw;
  if (jitter === "equal") return raw / 2 + random() * (raw / 2);
  return raw;
}

/** Tracks consecutive failures; `failure()` returns the next delay, `reset()` is called on success. */
export class Backoff {
  private count = 0;
  constructor(private readonly options: BackoffOptions) {}
  get failures(): number { return this.count; }
  failure(): number { return nextDelay(this.count++, this.options); }
  reset(): void { this.count = 0; }
}
