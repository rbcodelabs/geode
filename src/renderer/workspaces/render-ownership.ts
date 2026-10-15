/** Internal native-render lifecycle tracking; not part of the plugin API. */
export class ScopeCancelled extends Error {
  constructor() { super("The render owner changed before initialization completed."); }
}
export interface RenderFailure { error: unknown; key: string }
interface ScopeOptions { writer?: unknown; preflightClose?(): void; prepareClose?(): Promise<void>; failureKey?: string; close?(): Promise<void>; resume?(): void; recover?(failures: readonly RenderFailure[]): void }
export interface RenderToken { current(): boolean; check(): void }
function raise(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Native render ownership could not settle.");
}
export class RenderScope {
  private state: "active" | "frozen" | "closed" = "active";
  private generation = 0;
  private readonly children = new Set<RenderScope>();
  private readonly pending = new Set<Promise<unknown>>();
  private failures: RenderFailure[] = [];
  private closing: Promise<void> | undefined;
  constructor(private readonly registry: RenderOwnership, private readonly options: ScopeOptions = {}, private readonly parent?: RenderScope, private readonly owner?: object) {}
  get closed(): boolean { return this.state === "closed"; }
  get admissionAllowed(): boolean { return this.admits() && this.registry.admissionOpen; }
  get hasUnacknowledgedWrites(): boolean { return this.hasRetainedFailures(); }
  private admits(): boolean { return this.state === "active" && !this.closing && (!this.parent || this.parent.admits()); }
  assertAdmission(): void { if (!this.admits() || !this.registry.admissionOpen) throw new Error("Native render admission is paused during a workspace operation."); }
  child(options: ScopeOptions = {}): RenderScope {
    this.assertAdmission(); const child = new RenderScope(this.registry, options, this); this.children.add(child); return child;
  }
  run<T>(operation: (token: RenderToken) => Promise<T>, key?: string): Promise<T> {
    this.assertAdmission();
    const ancestry: { scope: RenderScope; generation: number }[] = [];
    for (let scope: RenderScope | undefined = this; scope; scope = scope.parent) ancestry.push({ scope, generation: scope.generation });
    const token: RenderToken = { current: () => this.admits() && ancestry.every(item => item.scope.generation === item.generation), check: () => { if (!token.current()) throw new ScopeCancelled(); } };
    // Register synchronously before invoking any asynchronous initializer.
    const task = Promise.resolve().then(() => { token.check(); return operation(token); });
    this.pending.add(task);
    // Read/render failures are reported to their caller. Only writes require a
    // retained acknowledgment before another barrier may discard their drafts.
    void task.then(() => this.pending.delete(task), error => {
      this.pending.delete(task);
      if (key !== undefined) {
        this.failures.push({ error, key });
        try { this.recoverTree(); } catch (recoveryError) { this.failures.push({ error: recoveryError, key }); }
      }
    });
    return task;
  }
  /** Only the successful explicit retry of an operation acknowledges its failures. */
  retry<T>(operation: (token: RenderToken) => Promise<T>, key: string): Promise<T> {
    const acknowledged = new Set(this.failures.filter(failure => failure.key === key));
    return this.run(operation, key).then(result => { this.failures = this.failures.filter(failure => !acknowledged.has(failure)); this.recoverTree(); return result; });
  }
  private freeze(): void {
    if (this.state === "closed") return;
    this.state = "frozen"; this.generation++;
    for (const child of this.children) child.freeze();
  }
  private async drainTasks(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    raise(this.failures.map(failure => failure.error));
  }
  async drain(): Promise<void> {
    if (this.closing) return this.closing;
    const errors: unknown[] = [];
    try { await this.drainTasks(); } catch (error) { errors.push(error); }
    for (const child of this.children) { try { await child.drain(); } catch (error) { errors.push(error); } }
    raise(errors);
  }
  freezeAdmission(): void { this.freeze(); }
  async freezeAndDrain(): Promise<void> { this.freeze(); await this.drain(); }
  writers(): unknown[] {
    const result: unknown[] = this.options.writer === undefined ? [] : [this.options.writer];
    for (const child of this.children) result.push(...child.writers());
    return result;
  }
  resume(): void {
    if (this.state !== "frozen") return;
    this.state = "active"; this.generation++;
    const errors: unknown[] = [];
    for (const child of this.children) { try { child.resume(); } catch (error) { errors.push(error); } }
    try { if (!this.hasRetainedFailures()) this.options.resume?.(); this.recoverTree(); } catch (error) { errors.push(error); }
    raise(errors);
  }
  private hasRetainedFailures(): boolean { return this.failures.length > 0 || [...this.children].some(child => child.hasRetainedFailures()); }
  private recoverTree(): void {
    if (!this.admissionAllowed) return;
    this.options.recover?.([...this.failures]);
    for (const child of this.children) child.recoverTree();
  }
  private async prepareCloseTree(): Promise<void> {
    await this.drainTasks();
    for (const child of this.children) await child.drain();
    try { await this.options.prepareClose?.(); }
    catch (error) { if (this.options.failureKey) this.failures.push({ error, key: this.options.failureKey }); throw error; }
    for (const child of this.children) await child.prepareCloseTree();
  }
  private preflightCloseTree(): void { this.options.preflightClose?.(); for (const child of this.children) child.preflightCloseTree(); }
  /** Prepare the complete affected set before permitting its first destructor. */
  static async prepareRetirement(affected: readonly RenderScope[]): Promise<{ commit(): Promise<void>; abort(): void }> {
    const unique = new Set(affected);
    const scopes = [...unique].filter(scope => {
      for (let parent = scope.parent; parent; parent = parent.parent) if (unique.has(parent)) return false;
      return true;
    });
    for (const scope of scopes) { scope.assertAdmission(); scope.preflightCloseTree(); }
    for (const scope of scopes) scope.freeze();
    const resume = () => {
      const errors: unknown[] = [];
      for (const scope of scopes) { try { scope.resume(); } catch (error) { errors.push(error); } }
      raise(errors);
    };
    try {
      const results = await Promise.allSettled(scopes.map(scope => scope.prepareCloseTree()));
      raise(results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
    } catch (error) {
      try { resume(); } catch (recoveryError) { throw new AggregateError([error, recoveryError], "Native retirement preparation and recovery failed."); }
      throw error;
    }
    let completion: Promise<void> | undefined;
    let aborted = false;
    return {
      abort: () => { if (!completion && !aborted) { aborted = true; resume(); } },
      commit: () => {
        if (aborted) return Promise.reject(new Error("This native retirement was canceled."));
        return completion ??= (async () => { for (const scope of scopes) await scope.startClose(true); })();
      },
    };
  }
  assertRetirementReady(): void { this.assertAdmission(); this.preflightCloseTree(); }
  close(): Promise<void> { return this.startClose(false); }
  private startClose(prepared: boolean): Promise<void> {
    if (this.closing) return this.closing;
    const previous = this.state;
    this.state = "closed"; this.generation++;
    this.closing = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try { if (!prepared) { this.preflightCloseTree(); await this.prepareCloseTree(); } } catch (error) { errors.push(error); }
      if (errors.length) {
        // No destructor has run: preserve the entire subtree and usable retry
        // controls. Ancestor admission still prevents detached children reopening.
        this.state = previous; this.closing = undefined;
        try { this.recoverTree(); } catch (error) { errors.push(error); }
        raise(errors);
      }
      if (!errors.length) for (const child of [...this.children]) {
        try { await child.startClose(true); } catch (error) { errors.push(error); break; }
      }
      if (!errors.length) { try { await this.options.close?.(); } catch (error) { errors.push(error); } }
      if (!errors.length) {
        this.parent?.children.delete(this);
        if (this.owner) this.registry.retire(this.owner, this);
      }
      raise(errors);
    });
    // Existing widget destroy() callers may begin tracked teardown synchronously.
    void this.closing.catch(() => {});
    return this.closing;
  }
}
export class RenderOwnership {
  private readonly roots = new Map<object, RenderScope>();
  admissionOpen = true;
  private holding: readonly RenderScope[] | null = null;
  create(owner: object, options: ScopeOptions = {}): RenderScope {
    if (!this.admissionOpen) throw new Error("Native render admission is paused during a workspace operation.");
    if (this.roots.has(owner)) throw new Error("This native render owner is already registered.");
    const scope = new RenderScope(this, options, undefined, owner); this.roots.set(owner, scope); return scope;
  }
  retire(owner: object, scope: RenderScope): void { if (this.roots.get(owner) === scope) this.roots.delete(owner); }
  select(owners: ReadonlySet<object>): RenderScope[] {
    if ([...this.roots].some(([owner, scope]) => !owners.has(owner) && scope.writers().length > 0)) throw new Error("A native writer is outside the registered workspace ownership tree.");
    return [...this.roots.values()];
  }
  async hold(owners: ReadonlySet<object>): Promise<RenderScope[]> {
    if (this.holding) throw new Error("A native ownership barrier is already in progress.");
    const scopes = this.select(owners); this.holding = scopes; this.admissionOpen = false;
    for (const scope of scopes) scope.freezeAdmission();
    try { const results = await Promise.allSettled(scopes.map(scope => scope.drain())); raise(results.flatMap(result => result.status === "rejected" ? [result.reason] : [])); return scopes; }
    catch (error) { this.release(scopes); throw error; }
  }
  release(scopes: readonly RenderScope[]): void {
    if (this.holding !== scopes) throw new Error("This ownership hold is no longer current.");
    this.holding = null; this.admissionOpen = true;
    const errors: unknown[] = [];
    for (const scope of scopes) { try { scope.resume(); } catch (error) { errors.push(error); } }
    raise(errors);
  }
}
const registries = new WeakMap<object, RenderOwnership>();
export function nativeRenderOwnership(app: object): RenderOwnership {
  let registry = registries.get(app); if (!registry) { registry = new RenderOwnership(); registries.set(app, registry); } return registry;
}
