import type { App } from "../../app";
import { Plugin as GeodePlugin } from "../../plugin";
import type { PluginManifest } from "../../plugin-manifest";
import type { OnboardingManifestStep } from "../../plugin-manifest";
import { computeCompleteness, type Completeness } from "./completeness";
import {
  AGENT_THREADS_ID,
  AGENT_THREADS_STEP_NAME,
  computeThreadsCard,
  installAgentThreads,
  type ThreadsCardView,
  type ThreadsInstallPhase,
} from "./agent-threads-recommendation";
import { firstPartySteps, ONBOARDING_PLUGIN_ID, type OnboardingHost } from "./first-party-steps";
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
  threadsCard: ThreadsCardView;
}

/** The slice of PluginManager the onboarding plugin needs (kept narrow for tests). */
export interface OnboardingPluginHost {
  listManifests(): PluginManifest[];
  getManifest(id: string): PluginManifest | undefined;
  isEnabled(id: string): boolean;
  enabledIds(): string[];
  enable?(id: string): Promise<void>;
  getLoadError?(id: string): string | undefined;
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

  /**
   * @param headlessProbe true under GEODE_HEADLESS / e2e; the preload exposes
   *   it as `window.geode.isHeadless`. Injectable for tests.
   */
  constructor(
    app: App,
    private readonly headlessProbe: () => boolean = () => (globalThis as any).window?.geode?.isHeadless === true
  ) {
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

    // Getters, not snapshots: the plugin manager is attached after onload.
    const self = this;
    const stepHost: OnboardingHost = {
      get metadataCache() {
        return self.app.metadataCache;
      },
      get pluginManager() {
        return self.host;
      },
      supportedInstallAvailable: typeof (globalThis as any).window?.geode?.installSupportedPlugin === "function",
      headless: this.headlessProbe(),
    };
    for (const step of firstPartySteps(stepHost)) this.register(this.registry.registerStep(step));
    this.addCommand({
      id: AGENT_THREADS_STEP_NAME,
      name: "Install Agent Threads",
      callback: () => this.installAgentThreads(),
    });

    this.addCommand({ id: "open", name: "Open checklist", callback: () => this.openChecklist() });
    this.addCommand({ id: "rerun-checks", name: "Re-run checks", callback: () => this.refresh() });
    this.addCommand({ id: "reset", name: "Reset progress", callback: () => this.resetProgress() });

    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    this.state = normalizeState(await this.loadData());
    // Baseline for "did anything genuinely change?": a vault with no data.json
    // is equivalent to the defaults, so a clean load never creates the file.
    this.persistedJson = JSON.stringify(this.state);
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
        // Auto-detected completions are kept in memory. They are written only
        // once the checklist is actually open (or with the next user-driven
        // change), so background startup/refresh never touches the vault.
        this.state = next;
        if (this.isChecklistOpen()) await this.persist();
      } catch (err) {
        console.warn("Onboarding refresh failed", err);
      }
      this.emit();
    });
    return this.refreshChain;
  }

  private isChecklistOpen(): boolean {
    return this.app.workspace.getLeavesOfType(ONBOARDING_VIEW_TYPE).length > 0;
  }

  /** Last JSON written to (or read from) disk; writes happen only when state differs from it. */
  private persistedJson = JSON.stringify(emptyState());

  private async persist(): Promise<void> {
    const json = JSON.stringify(this.state);
    if (json === this.persistedJson) return;
    try {
      await this.saveData(this.state);
      this.persistedJson = json;
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
    return {
      items,
      completeness,
      dismissedOnboarding: this.state.dismissedOnboarding,
      threadsCard: this.getThreadsCard(),
    };
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

  /**
   * Install Agent Threads through the existing supported-catalog path
   * (`CommunityManager.installSupported`). Failure (offline, catalog down) is
   * reported with a notice and never throws.
   */
  async installAgentThreads(): Promise<boolean> {
    this.app.notify(this.isThreadsInstalled() ? "Enabling Agent Threads…" : "Installing Agent Threads…");
    const ok = await this.runThreadsSetup();
    const failure =
      this.threadsPhase === "enable-failed"
        ? `Agent Threads is installed, but couldn't be enabled: ${this.threadsError}`
        : `Couldn't install Agent Threads: ${this.threadsError ?? "cancelled"}`;
    this.app.notify(ok ? "Agent Threads is installed and enabled." : failure, ok ? undefined : 8000);
    return ok;
  }

  // ----- "Recommended: Agent Threads" card -----

  private threadsPhase: ThreadsInstallPhase = "idle";
  private threadsError?: string;
  private threadsRun = 0;
  private threadsInstalledThisSession = false;
  private threadsDismissedThisSession = false;

  private isThreadsInstalled(): boolean {
    const host = this.host;
    return !!host && (!!host.getManifest(AGENT_THREADS_ID) || host.enabledIds().includes(AGENT_THREADS_ID));
  }

  private isThreadsEnabled(): boolean {
    return !!this.host && this.host.enabledIds().includes(AGENT_THREADS_ID);
  }

  getThreadsCard(): ThreadsCardView {
    const kind = computeThreadsCard({
      installed: this.isThreadsInstalled(),
      enabled: this.isThreadsEnabled(),
      installApiAvailable: typeof (globalThis as any).window?.geode?.installSupportedPlugin === "function",
      headless: this.headlessProbe(),
      dismissed: this.state.dismissedRecommendations.includes(AGENT_THREADS_ID),
      phase: this.threadsPhase,
      installedThisSession: this.threadsInstalledThisSession,
      dismissedThisSession: this.threadsDismissedThisSession,
    });
    return kind === "failed" || kind === "enable-failed" ? { kind, error: this.threadsError } : { kind };
  }

  /**
   * Install (if not installed) then enable, in one action, via the existing
   * `CommunityManager.installSupported` and `PluginManager.enable` paths.
   * Never throws and never leaves a silent half-done state: an install failure
   * ends in "failed", an enable failure in "enable-failed" (the plugin stays
   * installed). A cancelled run's late result is ignored.
   */
  private async runThreadsSetup(): Promise<boolean> {
    const run = ++this.threadsRun;
    this.threadsError = undefined;
    if (!this.isThreadsInstalled()) {
      this.threadsPhase = "installing";
      this.emit();
      const outcome = await installAgentThreads((id, release) => this.app.communityManager.installSupported(id, release));
      if (run !== this.threadsRun) return false; // cancelled; a late success still shows via refresh()
      if (!outcome.ok) {
        this.threadsPhase = "failed";
        this.threadsError = outcome.error;
        this.emit();
        return false;
      }
    }
    this.threadsPhase = "enabling";
    this.emit();
    try {
      if (!this.host?.enable) throw new Error("Plugin manager unavailable");
      await this.host.enable(AGENT_THREADS_ID);
      // enable() can contain a plugin error instead of throwing; verify it really loaded.
      if (!this.isThreadsEnabled()) {
        throw new Error(this.host.getLoadError?.(AGENT_THREADS_ID) ?? "The plugin did not start");
      }
    } catch (err) {
      if (run !== this.threadsRun) return false;
      this.threadsPhase = "enable-failed";
      this.threadsError = err instanceof Error ? err.message : String(err);
      await this.refresh();
      return false;
    }
    if (run !== this.threadsRun) return false;
    this.threadsPhase = "idle";
    this.threadsInstalledThisSession = true;
    await this.refresh();
    return true;
  }

  /** Card "Install" / "Enable" / "Retry": installs and/or enables as needed. */
  async startThreadsInstall(): Promise<void> {
    await this.runThreadsSetup();
  }

  /** Card "Cancel": returns to idle. The in-flight download cannot be aborted, only ignored. */
  cancelThreadsInstall(): void {
    this.threadsRun++;
    this.threadsPhase = "idle";
    this.emit();
  }

  /** Card "Not now" / "Skip": persisted; the optional checklist step remains. */
  async dismissThreadsCard(): Promise<void> {
    this.threadsRun++;
    this.threadsPhase = "idle";
    this.threadsDismissedThisSession = true;
    const s = this.state;
    if (s.dismissedRecommendations.includes(AGENT_THREADS_ID)) this.emit();
    else await this.update({ ...s, dismissedRecommendations: [...s.dismissedRecommendations, AGENT_THREADS_ID] });
  }

  async undoDismissThreadsCard(): Promise<void> {
    this.threadsDismissedThisSession = false;
    const s = this.state;
    await this.update({ ...s, dismissedRecommendations: s.dismissedRecommendations.filter((x) => x !== AGENT_THREADS_ID) });
    this.emit();
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

  /** True when a required (non-optional), incomplete, non-skipped step remains. */
  hasOutstandingSteps(): boolean {
    return this.getSnapshot().items.some((i) => !i.step.optional && !i.done && !i.skipped);
  }

  /**
   * Launch-time auto-open, called once the workspace layout is ready. Runs the
   * checks first so auto-detected steps do not cause a spurious open. Does
   * nothing when headless (e2e), when onboarding was dismissed, when the pane
   * is already open (restored layout), or when nothing required is outstanding.
   * Docks the pane in the right sidebar and shows it there without activating
   * it as the workspace's active leaf, so the editor keeps focus.
   * Returns whether it opened the pane.
   */
  async autoOpenIfOutstanding(): Promise<boolean> {
    if (this.isHeadless()) return false;
    await this.ready;
    if (this.disposed || this.state.dismissedOnboarding) return false;
    const workspace = this.app.workspace;
    if (workspace.getLeavesOfType(ONBOARDING_VIEW_TYPE).length > 0) return false;
    await this.refresh();
    if (this.disposed || !this.hasOutstandingSteps()) return false;
    // Re-check: the user (or a restore) may have opened it while checks ran.
    if (workspace.getLeavesOfType(ONBOARDING_VIEW_TYPE).length > 0) return false;
    const leaf = workspace.getRightLeaf(false);
    await leaf.setViewState({ type: ONBOARDING_VIEW_TYPE, active: false });
    // Sidebar reveal only: a docked group's activation never changes the
    // workspace's active (editor) group.
    workspace.revealLeaf(leaf);
    return true;
  }

  private isHeadless(): boolean {
    return this.headlessProbe();
  }
}
