import type { OnboardingManifestStep } from "../../plugin-manifest";

/** A recommended onboarding step, registered at runtime or declared in a plugin manifest. */
export interface OnboardingStep {
  /** Globally unique, namespaced by owner: `"<ownerId>:<stepId>"`. */
  id: string;
  /** Id of the plugin (or "onboarding" itself) that owns the step. */
  ownerId: string;
  title: string;
  description?: string;
  group?: string;
  /** Sort key within the list; lower first. Defaults to 1000. */
  order?: number;
  /** Optional steps are shown but do not count toward the completeness total. */
  optional?: boolean;
  /** Command invoked by the "Do it" action via `app.commands`. */
  commandId?: string;
  /**
   * Dynamic completion detection. Evaluated on open/refresh; a throw or a
   * rejection is treated as "incomplete". Steps with a `check` cannot be
   * toggled by hand.
   */
  check?: () => boolean | Promise<boolean>;
  docsUrl?: string;
}

/** A step as presented to the UI and score: static/runtime merged. */
export interface ResolvedStep extends OnboardingStep {
  /** "runtime" once a plugin registered it (even if a manifest also declared it). */
  origin: "runtime" | "static";
  /** False for manifest-declared steps whose owning plugin is installed but disabled. */
  ownerEnabled: boolean;
}

export class OnboardingRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingRegistryError";
  }
}

export const DEFAULT_STEP_ORDER = 1000;

interface Entry<T> {
  step: T;
  seq: number;
}

/**
 * Pure (DOM-free) store of onboarding steps.
 *
 * Two sources are merged:
 *  - runtime steps, added via {@link registerStep} and removed by the returned
 *    disposer (or {@link unregisterOwner} when the owning plugin unloads);
 *  - static steps, declared in `manifest.json` and pushed in with
 *    {@link setStaticSteps}. They show even while the owner is disabled.
 * A runtime step with the same id as a static one overrides it field-by-field,
 * which is how a plugin adds a `check` to its manifest-declared step.
 */
export class OnboardingRegistry {
  private runtime = new Map<string, Entry<OnboardingStep>>();
  private statics = new Map<string, Entry<OnboardingStep>>();
  private listeners = new Set<() => void>();
  private seq = 0;

  constructor(private readonly isOwnerEnabled: (ownerId: string) => boolean = () => true) {}

  /**
   * Register a runtime step. Returns a disposer that removes exactly this
   * registration (idempotent; it will not remove a later re-registration).
   * Throws {@link OnboardingRegistryError} for invalid input or a duplicate id.
   */
  registerStep(step: OnboardingStep): () => void {
    validateStep(step);
    if (this.runtime.has(step.id)) {
      throw new OnboardingRegistryError(
        `Onboarding step "${step.id}" is already registered (owner "${this.runtime.get(step.id)!.step.ownerId}")`
      );
    }
    const entry: Entry<OnboardingStep> = { step: { ...step }, seq: this.seq++ };
    this.runtime.set(step.id, entry);
    this.emit();
    return () => {
      if (this.runtime.get(step.id) !== entry) return;
      this.runtime.delete(step.id);
      this.emit();
    };
  }

  /** Remove every runtime step owned by `ownerId`. Returns how many were removed. */
  unregisterOwner(ownerId: string): number {
    let removed = 0;
    for (const [id, entry] of this.runtime) {
      if (entry.step.ownerId === ownerId) {
        this.runtime.delete(id);
        removed++;
      }
    }
    if (removed) this.emit();
    return removed;
  }

  /**
   * Replace ALL manifest-declared steps at once (owner id -> its steps), so a
   * rescan is a single change notification. Ids are namespaced
   * `<ownerId>:<id>`; owners absent from the map lose their static steps
   * (plugin uninstalled).
   */
  replaceStaticSteps(byOwner: ReadonlyMap<string, readonly OnboardingManifestStep[]>): void {
    this.statics.clear();
    for (const [ownerId, steps] of byOwner) {
      for (const s of steps) {
        const id = s.id.startsWith(`${ownerId}:`) ? s.id : `${ownerId}:${s.id}`;
        if (this.statics.has(id)) continue;
        this.statics.set(id, {
          seq: this.seq++,
          step: {
            id,
            ownerId,
            title: s.title,
            description: s.description,
            group: s.group,
            commandId: s.commandId,
            optional: s.optional,
          },
        });
      }
    }
    this.emit();
  }

  /** Merged, sorted view: by `order`, then registration sequence. */
  list(): ResolvedStep[] {
    const merged = new Map<string, { step: ResolvedStep; seq: number }>();
    for (const [id, entry] of this.statics) {
      merged.set(id, {
        seq: entry.seq,
        step: { ...entry.step, origin: "static", ownerEnabled: this.isOwnerEnabled(entry.step.ownerId) },
      });
    }
    for (const [id, entry] of this.runtime) {
      const base = merged.get(id);
      const step: ResolvedStep = {
        ...(base?.step ?? {}),
        ...definedOnly(entry.step),
        origin: "runtime",
        ownerEnabled: true,
      } as ResolvedStep;
      merged.set(id, { seq: base?.seq ?? entry.seq, step });
    }
    return [...merged.values()]
      .sort((a, b) => (a.step.order ?? DEFAULT_STEP_ORDER) - (b.step.order ?? DEFAULT_STEP_ORDER) || a.seq - b.seq)
      .map((e) => e.step);
  }

  get(id: string): ResolvedStep | undefined {
    return this.list().find((s) => s.id === id);
  }

  /** Subscribe to any change in the step set. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notify listeners without changing steps (e.g. plugin enable state flipped). */
  notify(): void {
    this.emit();
  }

  clear(): void {
    this.runtime.clear();
    this.statics.clear();
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        console.error("Onboarding listener failed", err);
      }
    }
  }
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}

function validateStep(step: OnboardingStep): void {
  if (!step || typeof step !== "object") throw new OnboardingRegistryError("Onboarding step must be an object");
  if (typeof step.ownerId !== "string" || !step.ownerId) {
    throw new OnboardingRegistryError("Onboarding step requires a non-empty ownerId");
  }
  if (typeof step.id !== "string" || !step.id.startsWith(`${step.ownerId}:`) || step.id.length <= step.ownerId.length + 1) {
    throw new OnboardingRegistryError(
      `Onboarding step id "${String(step.id)}" must be namespaced by its owner, e.g. "${step.ownerId}:my-step"`
    );
  }
  if (typeof step.title !== "string" || !step.title.trim()) {
    throw new OnboardingRegistryError(`Onboarding step "${step.id}" requires a non-empty title`);
  }
  if (step.check !== undefined && typeof step.check !== "function") {
    throw new OnboardingRegistryError(`Onboarding step "${step.id}" check must be a function`);
  }
}
