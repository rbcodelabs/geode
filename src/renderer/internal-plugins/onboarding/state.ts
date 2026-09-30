export type CompletionSource = "manual" | "auto";

export interface OnboardingState {
  version: 1;
  completed: Record<string, { completedAt: string; source: CompletionSource }>;
  dismissedSteps: string[];
  dismissedOnboarding: boolean;
}

export const CHECK_TIMEOUT_MS = 5000;

export function emptyState(): OnboardingState {
  return { version: 1, completed: {}, dismissedSteps: [], dismissedOnboarding: false };
}

/** Tolerant loader for persisted `data.json`: anything malformed falls back to defaults, never throws. */
export function normalizeState(raw: unknown): OnboardingState {
  const state = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state;
  const r = raw as Record<string, unknown>;
  if (r.completed && typeof r.completed === "object" && !Array.isArray(r.completed)) {
    for (const [id, entry] of Object.entries(r.completed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.completedAt !== "string") continue;
      state.completed[id] = { completedAt: e.completedAt, source: e.source === "auto" ? "auto" : "manual" };
    }
  }
  if (Array.isArray(r.dismissedSteps)) {
    state.dismissedSteps = [...new Set(r.dismissedSteps.filter((x): x is string => typeof x === "string"))];
  }
  state.dismissedOnboarding = r.dismissedOnboarding === true;
  return state;
}

export function markComplete(state: OnboardingState, id: string, source: CompletionSource, now: Date): OnboardingState {
  if (state.completed[id]) return state;
  return { ...state, completed: { ...state.completed, [id]: { completedAt: now.toISOString(), source } } };
}

export function unmarkComplete(state: OnboardingState, id: string): OnboardingState {
  if (!state.completed[id]) return state;
  const { [id]: _removed, ...rest } = state.completed;
  return { ...state, completed: rest };
}

export function dismissStep(state: OnboardingState, id: string): OnboardingState {
  return state.dismissedSteps.includes(id) ? state : { ...state, dismissedSteps: [...state.dismissedSteps, id] };
}

export function restoreStep(state: OnboardingState, id: string): OnboardingState {
  return state.dismissedSteps.includes(id)
    ? { ...state, dismissedSteps: state.dismissedSteps.filter((s) => s !== id) }
    : state;
}

export interface CheckableStep {
  id: string;
  check?: () => boolean | Promise<boolean>;
}

/** Run one check; a throw, rejection, non-boolean or timeout counts as incomplete. Never throws. */
export async function runCheck(step: CheckableStep, timeoutMs = CHECK_TIMEOUT_MS): Promise<boolean> {
  if (!step.check) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([Promise.resolve().then(() => step.check!()), timeout]);
    return result === true;
  } catch (err) {
    console.warn(`Onboarding check for "${step.id}" failed; treating as incomplete`, err);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Evaluate every step's `check` and fold the results into state: a passing
 * check auto-completes the step. Completion is sticky (a later failing or
 * erroring check does not undo it), because many onboarding milestones, like
 * "open the graph", are transient conditions. Returns the same `state` object
 * when nothing changed.
 */
export async function applyChecks(
  state: OnboardingState,
  steps: readonly CheckableStep[],
  now: Date,
  timeoutMs = CHECK_TIMEOUT_MS
): Promise<OnboardingState> {
  const checked = steps.filter((s) => s.check);
  const results = await Promise.all(checked.map(async (s) => [s.id, await runCheck(s, timeoutMs)] as const));
  let next = state;
  for (const [id, ok] of results) {
    if (ok) next = markComplete(next, id, "auto", now);
  }
  return next;
}
