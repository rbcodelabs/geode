/**
 * Per-absolute-path async lock. Ensures `fs` calls against the same path
 * (e.g. a write followed by a rename, or two renames touching a shared
 * path) never interleave, closing a compounding race between the
 * `vault-write`/`vault-rename`/`vault-delete` IPC handlers in main.ts.
 * Independent of the renderer-side `Vault.rename()` identity fix — this is
 * main-process hardening against overlapping fs operations on one path.
 */
const pathLocks = new Map<string, Promise<unknown>>();

export function withPathLock<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths)].sort();
  const prior = Promise.all(keys.map((k) => pathLocks.get(k) ?? Promise.resolve()));
  const run = prior.then(fn, fn); // run fn regardless of prior op's outcome
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  for (const k of keys) pathLocks.set(k, settled);
  return run;
}
