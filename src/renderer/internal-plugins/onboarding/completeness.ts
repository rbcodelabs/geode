export const DEFAULT_GROUP = "General";

export interface ScoredStep {
  id: string;
  ownerId: string;
  group?: string;
  optional?: boolean;
}

export interface Tally {
  completed: number;
  total: number;
  /** Whole-number 0-100. An empty tally is 100: nothing is left to do. */
  percent: number;
}

export interface Completeness extends Tally {
  byGroup: Record<string, Tally>;
  byOwner: Record<string, Tally>;
  /** Optional steps are reported separately; they never affect `total`/`percent`. */
  optional: { completed: number; total: number };
}

const toPercent = (completed: number, total: number): number =>
  total === 0 ? 100 : Math.round((completed / total) * 100);

/**
 * Pure completeness score. Only required (non-optional) steps count toward
 * `completed`/`total`/`percent`; `skipped` steps (dismissed by the user) are
 * excluded entirely from the required total, since the user opted out.
 */
export function computeCompleteness(
  steps: readonly ScoredStep[],
  isDone: (stepId: string) => boolean,
  isSkipped: (stepId: string) => boolean = () => false
): Completeness {
  const counts = { completed: 0, total: 0 };
  const optional = { completed: 0, total: 0 };
  const byGroup: Record<string, { completed: number; total: number }> = {};
  const byOwner: Record<string, { completed: number; total: number }> = {};

  for (const step of steps) {
    const done = isDone(step.id);
    if (step.optional) {
      optional.total++;
      if (done) optional.completed++;
      continue;
    }
    if (isSkipped(step.id) && !done) continue;
    const group = step.group ?? DEFAULT_GROUP;
    const g = (byGroup[group] ??= { completed: 0, total: 0 });
    const o = (byOwner[step.ownerId] ??= { completed: 0, total: 0 });
    counts.total++;
    g.total++;
    o.total++;
    if (done) {
      counts.completed++;
      g.completed++;
      o.completed++;
    }
  }

  const finish = (src: Record<string, { completed: number; total: number }>): Record<string, Tally> =>
    Object.fromEntries(
      Object.entries(src).map(([k, v]) => [k, { ...v, percent: toPercent(v.completed, v.total) }])
    );

  return {
    ...counts,
    percent: toPercent(counts.completed, counts.total),
    byGroup: finish(byGroup),
    byOwner: finish(byOwner),
    optional,
  };
}
