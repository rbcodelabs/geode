/**
 * Launch sequence: an ordered list of steps run while a vault opens, with
 * live status. Pure and DOM-free (like the onboarding registry) so it can be
 * unit tested; the overlay lives in launch-overlay.ts.
 *
 * Two phases exist because plugins are only loaded part-way through opening:
 *  - "before-plugins": internal/built-in steps only (e.g. plugin updates, so an
 *    update is a plain on-disk install with no live plugin to hot-reload);
 *  - "after-plugins": plugins register steps in `onload()`.
 */

export type LaunchPhase = "before-plugins" | "after-plugins";
export type LaunchStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export const DEFAULT_LAUNCH_STEP_ORDER = 1000;
/** Per-step budget for plugin-registered steps unless they pass `timeoutMs`. */
export const DEFAULT_PLUGIN_STEP_TIMEOUT_MS = 60_000;

export interface LaunchStepContext {
  /** Aborted on timeout, on Skip, and when the owning plugin unloads. */
  signal: AbortSignal;
  /** A string shows as detail text; a number in 0..1 drives the step's own bar. */
  setProgress(value: string | number): void;
  setTitle(title: string): void;
}

/** A step may resolve `"skipped"` to report that it chose to do nothing. */
export type LaunchStepResult = void | "skipped";

/** Step shape available to plugins (always runs in "after-plugins"). */
export interface LaunchStep {
  /** Globally unique, namespaced by owner: `"<pluginId>:<stepId>"`. */
  id: string;
  title: string;
  description?: string;
  /** Sort key within the phase; lower first. Defaults to 1000. */
  order?: number;
  /** Optional steps show a Skip button while running. Default false. */
  optional?: boolean;
  /** Default 60s for plugin steps. A timeout marks the step failed and launch continues. */
  timeoutMs?: number;
  run(ctx: LaunchStepContext): LaunchStepResult | Promise<LaunchStepResult>;
}

/** Internal step shape: adds the phase. */
export interface InternalLaunchStep extends Omit<LaunchStep, "timeoutMs"> {
  phase?: LaunchPhase;
  timeoutMs?: number;
}

export interface RegisteredLaunchStep extends InternalLaunchStep {
  ownerId: string;
  phase: LaunchPhase;
}

export class LaunchRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchRegistryError";
  }
}

export class LaunchRegistry {
  private steps = new Map<string, { step: RegisteredLaunchStep; seq: number }>();
  private listeners = new Set<() => void>();
  private seq = 0;

  /**
   * Register a step. Returns an idempotent disposer that removes exactly this
   * registration. Throws {@link LaunchRegistryError} on invalid input or a
   * duplicate id.
   */
  registerStep(step: InternalLaunchStep): () => void {
    const registered = validate(step);
    if (this.steps.has(step.id)) {
      throw new LaunchRegistryError(`Launch step "${step.id}" is already registered`);
    }
    const entry = { step: registered, seq: this.seq++ };
    this.steps.set(step.id, entry);
    this.emit();
    return () => {
      if (this.steps.get(step.id) !== entry) return;
      this.steps.delete(step.id);
      this.emit();
    };
  }

  /** Remove every step owned by `ownerId`. Returns how many were removed. */
  unregisterOwner(ownerId: string): number {
    let removed = 0;
    for (const [id, entry] of this.steps) {
      if (entry.step.ownerId === ownerId) {
        this.steps.delete(id);
        removed++;
      }
    }
    if (removed) this.emit();
    return removed;
  }

  /** Steps for a phase, ordered by `order` then registration sequence. */
  list(phase?: LaunchPhase): RegisteredLaunchStep[] {
    return [...this.steps.values()]
      .filter((e) => !phase || e.step.phase === phase)
      .sort(
        (a, b) =>
          (a.step.order ?? DEFAULT_LAUNCH_STEP_ORDER) - (b.step.order ?? DEFAULT_LAUNCH_STEP_ORDER) || a.seq - b.seq
      )
      .map((e) => e.step);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.steps.clear();
    this.listeners.clear();
  }

  private emit(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (err) {
        console.error("Launch listener failed", err);
      }
    }
  }
}

function validate(step: InternalLaunchStep): RegisteredLaunchStep {
  if (!step || typeof step !== "object") throw new LaunchRegistryError("Launch step must be an object");
  const colon = typeof step.id === "string" ? step.id.indexOf(":") : -1;
  if (colon < 1 || colon === step.id.length - 1) {
    throw new LaunchRegistryError(
      `Launch step id "${String(step.id)}" must be namespaced by its owner, e.g. "my-plugin:create-sandbox"`
    );
  }
  if (typeof step.title !== "string" || !step.title.trim()) {
    throw new LaunchRegistryError(`Launch step "${step.id}" requires a non-empty title`);
  }
  if (typeof step.run !== "function") {
    throw new LaunchRegistryError(`Launch step "${step.id}" run must be a function`);
  }
  if (step.timeoutMs !== undefined && !(Number.isFinite(step.timeoutMs) && step.timeoutMs > 0)) {
    throw new LaunchRegistryError(`Launch step "${step.id}" timeoutMs must be a positive number`);
  }
  const phase = step.phase ?? "after-plugins";
  if (phase !== "before-plugins" && phase !== "after-plugins") {
    throw new LaunchRegistryError(`Launch step "${step.id}" has unknown phase "${String(phase)}"`);
  }
  return { ...step, ownerId: step.id.slice(0, colon), phase };
}

/** The surface plugins see as `app.launch`: after-plugins steps only. */
export interface LaunchApi {
  /** Register a step to run, after plugins load, while the launch screen is up. Call from `onload()`. */
  registerStep(step: LaunchStep): () => void;
}

export function createLaunchApi(registry: LaunchRegistry): LaunchApi {
  return {
    registerStep(step: LaunchStep) {
      if (step && typeof step === "object" && (step as InternalLaunchStep).phase !== undefined) {
        throw new LaunchRegistryError("Plugins cannot choose a launch phase; steps run after plugins load");
      }
      return registry.registerStep({ ...step, timeoutMs: step?.timeoutMs ?? DEFAULT_PLUGIN_STEP_TIMEOUT_MS });
    },
  };
}

export interface LaunchStepState {
  id: string;
  ownerId: string;
  phase: LaunchPhase;
  title: string;
  description?: string;
  optional: boolean;
  status: LaunchStepStatus;
  /** Free-text detail from `setProgress(string)`, or the failure message. */
  detail?: string;
  /** 0..1 from `setProgress(number)`. */
  fraction?: number;
  error?: string;
  durationMs?: number;
}

export interface LaunchSnapshot {
  steps: LaunchStepState[];
  /** Id of the running step, if any. */
  activeStepId: string | null;
  /** Settled steps / known steps, 0..1. */
  progress: number;
  /** True once every phase the host intends to run has finished. */
  finished: boolean;
}

interface Running {
  controller: AbortController;
  skip: (reason: string) => void;
  ownerId: string;
}

export class LaunchRunner {
  private states = new Map<string, LaunchStepState>();
  private running = new Map<string, Running>();
  private listeners = new Set<() => void>();
  private activeStepId: string | null = null;
  private finished = false;

  constructor(private readonly registry: LaunchRegistry) {
    registry.onChange(() => this.emit());
  }

  /**
   * Run every step of `phase` sequentially. Steps registered while the phase is
   * running are picked up before it ends. A failing, timing-out or throwing
   * step never rejects this promise.
   */
  async runPhase(phase: LaunchPhase): Promise<void> {
    for (;;) {
      const next = this.registry.list(phase).find((s) => !this.states.has(s.id));
      if (!next) break;
      await this.runStep(next);
    }
  }

  /** Mark the sequence complete (overlay dismisses). */
  finish(): void {
    this.finished = true;
    this.emit();
  }

  /** Skip the running step if it is optional. Returns whether a skip was issued. */
  skipActive(): boolean {
    const id = this.activeStepId;
    if (!id) return false;
    const state = this.states.get(id);
    if (!state?.optional) return false;
    this.running.get(id)?.skip("skipped by user");
    return true;
  }

  /** Abort running steps (and drop pending ones) owned by an unloading plugin. */
  unregisterOwner(ownerId: string): void {
    this.registry.unregisterOwner(ownerId);
    for (const run of this.running.values()) {
      if (run.ownerId === ownerId) run.skip("owner unloaded");
    }
  }

  getSnapshot(): LaunchSnapshot {
    const steps: LaunchStepState[] = [...this.states.values()];
    for (const s of this.registry.list()) {
      if (this.states.has(s.id)) continue;
      steps.push({
        id: s.id,
        ownerId: s.ownerId,
        phase: s.phase,
        title: s.title,
        description: s.description,
        optional: !!s.optional,
        status: "pending",
      });
    }
    // before-plugins first, then by registry order within phase.
    const rank = (p: LaunchPhase) => (p === "before-plugins" ? 0 : 1);
    const order = new Map(this.registry.list().map((s, i) => [s.id, i] as const));
    steps.sort(
      (a, b) =>
        rank(a.phase) - rank(b.phase) ||
        (this.startIndex(a.id) - this.startIndex(b.id)) ||
        (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
    );
    const settled = steps.filter((s) => s.status !== "pending" && s.status !== "running").length;
    return {
      steps: steps.map((s) => ({ ...s })),
      activeStepId: this.activeStepId,
      progress: steps.length ? settled / steps.length : 1,
      finished: this.finished,
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private startCounter = 0;
  private startOrder = new Map<string, number>();
  private startIndex(id: string): number {
    return this.startOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
  }

  private async runStep(step: RegisteredLaunchStep): Promise<void> {
    const state: LaunchStepState = {
      id: step.id,
      ownerId: step.ownerId,
      phase: step.phase,
      title: step.title,
      description: step.description,
      optional: !!step.optional,
      status: "running",
    };
    this.states.set(step.id, state);
    this.startOrder.set(step.id, this.startCounter++);
    this.activeStepId = step.id;

    const controller = new AbortController();
    let settled = false;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let skipFn: (reason: string) => void = () => {};

    const outcome = new Promise<{ kind: "skipped" | "failed"; message: string }>((resolve) => {
      skipFn = (reason) => {
        if (settled) return;
        controller.abort(new Error(reason));
        resolve({ kind: "skipped", message: reason });
      };
      if (step.timeoutMs) {
        timer = setTimeout(() => {
          if (settled) return;
          const message = `timed out after ${Math.round(step.timeoutMs! / 1000)}s`;
          controller.abort(new Error(message));
          resolve({ kind: "failed", message });
        }, step.timeoutMs);
      }
    });
    this.running.set(step.id, { controller, skip: skipFn, ownerId: step.ownerId });

    const ctx: LaunchStepContext = {
      signal: controller.signal,
      setProgress: (value) => {
        if (settled) return;
        if (typeof value === "number") {
          state.fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
        } else {
          state.detail = String(value);
        }
        this.emit();
      },
      setTitle: (title) => {
        if (settled || typeof title !== "string" || !title.trim()) return;
        state.title = title;
        this.emit();
      },
    };

    this.emit();

    const work = (async (): Promise<{ kind: "done" | "skipped" | "failed"; message?: string }> => {
      try {
        const result = await step.run(ctx);
        return result === "skipped" ? { kind: "skipped" } : { kind: "done" };
      } catch (err) {
        return { kind: "failed", message: err instanceof Error ? err.message : String(err) };
      }
    })();

    const result = await Promise.race([work, outcome]);
    settled = true;
    if (timer) clearTimeout(timer);
    this.running.delete(step.id);
    // A step that ignores its signal may reject later; it must not surface as unhandled.
    void work.catch(() => {});

    state.status = result.kind;
    if (result.kind === "failed") {
      state.error = result.message;
      state.detail = result.message;
      console.error(`Launch step "${step.id}" failed: ${result.message}`);
    } else if (result.kind === "skipped" && result.message) {
      state.detail = result.message;
    }
    state.fraction = undefined;
    state.durationMs = Date.now() - started;
    this.activeStepId = null;
    this.emit();
  }

  private emit(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (err) {
        console.error("Launch listener failed", err);
      }
    }
  }
}

/** One-line notice text for failed steps, or null when all went fine. */
export function summarizeLaunchFailures(snapshot: LaunchSnapshot): string | null {
  const failed = snapshot.steps.filter((s) => s.status === "failed");
  if (!failed.length) return null;
  const names = failed.map((s) => s.title).join(", ");
  return `${failed.length} launch step${failed.length === 1 ? "" : "s"} failed (${names}) — see console. Your vault opened normally.`;
}
