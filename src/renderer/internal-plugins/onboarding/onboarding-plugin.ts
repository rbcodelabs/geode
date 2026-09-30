import type { App } from "../../app";
import { Plugin as GeodePlugin } from "../../plugin";
import type { PluginManifest } from "../../plugin-manifest";
import type { OnboardingManifestStep } from "../../plugin-manifest";
import { computeCompleteness, type Completeness } from "./completeness";
import { firstPartySteps, ONBOARDING_PLUGIN_ID } from "./first-party-steps";
import { OnboardingRegistry, type OnboardingStep, type ResolvedStep } from "./registry";
import {
  applyChecks,
  dismissStep,
  emptyState,
  markComplete,
  normalizeState,
  restoreStep,
  unmarkComplete,
  type CompletionSource,
  type OnboardingState,
} from "./state";

export const ONBOARDING_VIEW_TYPE = "onboarding-checklist";

export const ONBOARDING_MANIFEST: PluginManifest = {
  id: ONBOARDING_PLUGIN_ID,
  name: "Onboarding",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "A getting-started checklist and completeness score. Other plugins can recommend steps.",
  author: "Geode",
};

export interface OnboardingItem {
  step: ResolvedStep;
  done: boolean;
  source?: CompletionSource;
  skipped: boolean;
}

export interface OnboardingSnapshot {
  items: OnboardingItem[];
  completeness: Completeness;
  dismissedOnboarding: boolean;
}

/** The slice of PluginManager the onboarding plugin needs (kept narrow for tests). */
export interface OnboardingPluginHost {
  listManifests(): PluginManifest[];
  getManifest(id: string): PluginManifest | undefined;
  isEnabled(id: string): boolean;
  enabledIds(): string[];
  enable?(id: string): Promise<void>;
  onChange?(listener: () => void): () => void;
}

/**
 * Onboarding checklist + completeness score, shipped as an *internal plugin*
 * (same pattern as Mermaid: `App` instantiates it directly on vault open).
 *
 * Ordering guarantee: it is constructed and loaded in `App` *before*
 * `PluginManager.initialize()`, and `App` awaits {@link ready}. So
 * `app.onboarding` / `app.plugins.getPlugin("onboarding")` exist by the time
 * any vault plugin's `onload()` runs and no early registration can be lost.
 * The registry is also created in the constructor, so a registration made even
 * before `onload()` is retained rather than dropped.
 */
export class OnboardingPlugin extends GeodePlugin {
  readonly registry: OnboardingRegistry;
  /** Resolves once persisted state is loaded and the view is registered. */
  ready: Promise<void> = Promise.resolve();
  private state: OnboardingState = emptyState();
  private host?: OnboardingPluginHost;
  private disposed = false;
  private refreshChain: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(app: App) {
    super(app, ONBOARDING_MANIFEST);
    this.registry = new OnboardingRegistry((ownerId) => this.isOwnerEnabled(ownerId));
  }

  // ----- public API (app.onboarding / app.plugins.getPlugin("onboarding")) -----

  /** Register a recommended step. Returns a disposer; also removed automatically when the owner plugin unloads. */
  registerStep(step: OnboardingStep): () => void {
    const dispose = this.registry.registerStep(step);
    void this.refresh();
    return dispose;
  }

  /** Subscribe to any change (steps, completion, dismissal). Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ----- lifecycle -----

  onload(): void {
    this.disposed = false;
    this.register(this.registry.onChange(() => this.emit()));
    this.register(() => {
      this.disposed = true;
      this.registry.clear();
      this.listeners.clear();
    });

    for (const step of firstPartySteps(this.app)) this.register(this.registry.registerStep(step));

    this.addCommand({ id: "open", name: "Open checklist", callback: () => this.openChecklist() });
    this.addCommand({ id: "rerun-checks", name: "Re-run checks", callback: () => this.refresh() });
    this.addCommand({ id: "reset", name: "Reset progress", callback: () => this.resetProgress() });

    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    this.state = normalizeState(await this.loadData());
    if (this.disposed) return;
    // Imported lazily: the view extends ItemView from api/obsidian.ts, which
    // re-exports App, so a static import here would recreate the init-time
    // cycle documented in app.ts next to the Bookmarks view.
    const { OnboardingView } = await import("./onboarding-view");
    if (this.disposed) return;
    this.registerView(ONBOARDING_VIEW_TYPE, (leaf) => new OnboardingView(leaf, this));
    await this.refresh();
  }

  /**
   * Connect the vault plugin manager: mirrors manifest-declared steps into the
   * registry and drops runtime steps of plugins that unloaded. Called by App
   * right after the manager is constructed (before `initialize()`).
   */
  attachPluginManager(host: OnboardingPluginHost): void {
    this.host = host;
    const sync = () => this.syncWithPluginManager();
    const off = host.onChange?.(sync);
    if (off) this.register(off);
    sync();
  }

  private syncWithPluginManager(): void {
    const host = this.host;
    if (!host || this.disposed) return;
    const byOwner = new Map<string, readonly OnboardingManifestStep[]>();
    for (const manifest of host.listManifests()) {
      if (manifest.id === ONBOARDING_PLUGIN_ID) continue;
      if (manifest.onboarding?.steps.length) byOwner.set(manifest.id, manifest.onboarding.steps);
      // Belt and braces: a plugin that forgot to dispose its steps still loses them on disable.
      if (!host.isEnabled(manifest.id)) this.registry.unregisterOwner(manifest.id);
    }
    this.registry.replaceStaticSteps(byOwner);
    void this.refresh();
  }

  private isOwnerEnabled(ownerId: string): boolean {
    const host = this.host;
    if (!host || !host.getManifest(ownerId)) return true;
    return host.isEnabled(ownerId);
  }

  // ----- state & checks -----

  /** Run dynamic checks, persist any auto-completions, and notify listeners. Never rejects. */
  refresh(): Promise<void> {
    this.refreshChain = this.refreshChain.then(async () => {
      if (this.disposed) return;
      try {
        const next = await applyChecks(this.state, this.registry.list(), new Date());
        if (next !== this.state) {
          this.state = next;
          await this.persist();
        }
      } catch (err) {
        console.warn("Onboarding refresh failed", err);
      }
      this.emit();
    });
    return this.refreshChain;
  }

  private async persist(): Promise<void> {
    try {
      await this.saveData(this.state);
    } catch (err) {
      console.warn("Onboarding state could not be saved", err);
    }
  }

  private async update(next: OnboardingState): Promise<void> {
    if (next === this.state) return;
    this.state = next;
    this.emit();
    await this.persist();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        console.error("Onboarding listener failed", err);
      }
    }
  }

  getSnapshot(): OnboardingSnapshot {
    const steps = this.registry.list();
    const skipped = new Set(this.state.dismissedSteps);
    const items = steps.map((step) => ({
      step,
      done: this.state.completed[step.id] !== undefined,
      source: this.state.completed[step.id]?.source,
      skipped: skipped.has(step.id),
    }));
    const byId = new Map(items.map((i) => [i.step.id, i]));
    const completeness = computeCompleteness(
      steps,
      (id) => byId.get(id)?.done ?? false,
      (id) => byId.get(id)?.skipped ?? false
    );
    return { items, completeness, dismissedOnboarding: this.state.dismissedOnboarding };
  }

  /** Manual toggle. Ignored for steps with a dynamic `check` (those complete themselves). */
  async toggleStep(id: string): Promise<void> {
    const step = this.registry.get(id);
    if (!step || step.check) return;
    const done = this.state.completed[id] !== undefined;
    await this.update(done ? unmarkComplete(this.state, id) : markComplete(this.state, id, "manual", new Date()));
  }

  async skipStep(id: string): Promise<void> {
    await this.update(dismissStep(this.state, id));
  }

  async unskipStep(id: string): Promise<void> {
    await this.update(restoreStep(this.state, id));
  }

  async setOnboardingDismissed(dismissed: boolean): Promise<void> {
    await this.update({ ...this.state, dismissedOnboarding: dismissed });
  }

  async resetProgress(): Promise<void> {
    await this.update(emptyState());
    await this.refresh();
    this.app.notify("Onboarding progress reset");
  }

  /** Run a step's command. Returns false (and tells the user) if it is unavailable. */
  runStep(id: string): boolean {
    const step = this.registry.get(id);
    if (!step?.commandId) return false;
    const ran = this.app.commands.execute(step.commandId);
    if (!ran) {
      this.app.notify(`Command "${step.commandId}" is not available`);
      return false;
    }
    // Commands often complete asynchronously (opening a pane, creating a file).
    setTimeout(() => void this.refresh(), 750);
    return true;
  }

  /** Enable the plugin that owns a static step (used by the "plugin disabled" affordance). */
  async enableOwner(ownerId: string): Promise<void> {
    await this.host?.enable?.(ownerId);
  }

  ownerName(ownerId: string): string {
    if (ownerId === ONBOARDING_PLUGIN_ID) return "Geode";
    return this.host?.getManifest(ownerId)?.name ?? ownerId;
  }

  async openChecklist(): Promise<void> {
    await this.ready;
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType(ONBOARDING_VIEW_TYPE)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      await this.refresh();
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    await leaf.setViewState({ type: ONBOARDING_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }
}
