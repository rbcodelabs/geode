/** Internal native-render lifecycle tracking; not part of the plugin API. */
export class ScopeCancelled extends Error {
  constructor() { super("The render owner changed before initialization completed."); }
}
interface ScopeOptions { writer?: unknown; close?(): Promise<void>; resume?(): void }
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
  private failures: { error: unknown; key?: string }[] = [];
  private closing: Promise<void> | undefined;
  constructor(private readonly registry: RenderOwnership, private readonly options: ScopeOptions = {}, private readonly parent?: RenderScope, private readonly owner?: object) {}
  get closed(): boolean { return this.state === "closed"; }
  private admits(): boolean { return this.state === "active" && !this.closing && (!this.parent || this.parent.admits()); }
  assertAdmission(): void { if (!this.admits() || !this.registry.admissionOpen) throw new Error("Native render admission is paused during a workspace operation."); }
  child(options: ScopeOptions = {}): RenderScope {
    this.assertAdmission(); const child = new RenderScope(this.registry, options, this); this.children.add(child); return child;
  }
  run<T>(operation: (token: RenderToken) => Promise<T>, key?: string): Promise<T> {
    this.assertAdmission(); const generation = this.generation;
    const token: RenderToken = { current: () => this.admits() && this.generation === generation, check: () => { if (!token.current()) throw new ScopeCancelled(); } };
    // Register synchronously before invoking any asynchronous initializer.
    const task = Promise.resolve().then(() => { token.check(); return operation(token); });
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), error => { this.pending.delete(task); if (key !== undefined || !(error instanceof ScopeCancelled)) this.failures.push({ error, key }); });
    return task;
  }
  /** Only the successful explicit retry of an operation acknowledges its failures. */
  retry<T>(operation: (token: RenderToken) => Promise<T>, key: string): Promise<T> {
    const acknowledged = new Set(this.failures.filter(failure => failure.key === key));
    return this.run(operation, key).then(result => { this.failures = this.failures.filter(failure => !acknowledged.has(failure)); return result; });
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
    try { this.options.resume?.(); } catch (error) { errors.push(error); }
    raise(errors);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const previous = this.state;
    this.state = "closed"; this.generation++;
    this.closing = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try { await this.drainTasks(); } catch (error) { errors.push(error); }
      for (const child of this.children) { try { await child.drain(); } catch (error) { errors.push(error); } }
      if (errors.length) {
        // No destructor has run: preserve the entire subtree and usable retry
        // controls. Ancestor admission still prevents detached children reopening.
        this.state = previous; this.closing = undefined; raise(errors);
      }
      if (!errors.length) for (const child of [...this.children]) {
        try { await child.close(); } catch (error) { errors.push(error); break; }
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
