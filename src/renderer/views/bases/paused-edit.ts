// Private renderer admission witnesses. Neither message text nor wrapped promises
// authorize a focus repair; only this exact immediate paused refusal does.
const errors = new WeakSet<object>();
const attempts = new WeakSet<object>();
export function rejectPausedBaseEdit(): Promise<never> {
  const error = new Error("Base edits are paused during a workspace operation.");
  errors.add(error);
  const attempt = Promise.reject(error);
  attempts.add(attempt);
  return attempt;
}
export function isPausedBaseEditError(error: unknown): boolean { return typeof error === "object" && error !== null && errors.has(error); }
export function isPausedBaseEditAttempt(attempt: object): boolean { return attempts.has(attempt); }
export interface BaseSyncFocusReceipt {
  readonly input: HTMLInputElement;
  restore(eligible: () => boolean): Promise<void>;
  discard(): void;
}
