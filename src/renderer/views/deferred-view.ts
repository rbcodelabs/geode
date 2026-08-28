import type { View } from "../workspace";

/** Everything a deferred leaf needs to keep its place and re-serialize losslessly. */
export interface DeferredViewInit {
  /** The persisted view type this placeholder stands in for. */
  type: string;
  /** The persisted view state, passed back verbatim when the real view arrives. */
  state?: unknown;
  /** The persisted tab/pane title, so the user sees "Kanban", not "claude-threads-kanban". */
  title?: string;
  /**
   * The persisted icon id. Not cosmetic: `Sidebar.renderIcons()` builds
   * icon-only tabs, so a deferred sidebar pane with no icon renders as an
   * invisible strip entry — indistinguishable from the pane having vanished,
   * which is the bug this whole mechanism exists to fix.
   */
  icon?: string;
}

/** Shown when the provider is missing outright, rather than merely not loaded yet. */
const DEFAULT_MESSAGE = "This pane's plugin isn't loaded. Restart with plugins to restore it.";

/**
 * A placeholder standing in for a view whose factory isn't registered right
 * now — a plugin that is disabled, quarantined, suppressed by crash recovery,
 * mid-update, or simply slower than `PLUGIN_ONLOAD_TIMEOUT_MS`.
 *
 * It **impersonates** the persisted view type: `viewType` returns the saved
 * type string and `getState()` returns the saved state object by identity.
 * That is what makes the whole mechanism cheap — `Workspace.getLeavesOfType`
 * and `Workspace.serializeLeaf` both key off `leaf.view.viewType` and already
 * do the right thing, so persistence is lossless with no `instanceof` branch
 * in the serializer, and the standard plugin idiom
 * `if (getLeavesOfType(VIEW).length) return;` still finds the pane.
 *
 * Impersonation is only safe because callers never see a `DeferredView`
 * standing in for a type they might `as`-cast (see
 * `Workspace.isDeferrableViewType` — built-ins are never deferred).
 */
export class DeferredView implements View {
  containerEl: HTMLElement;
  private messageEl: HTMLElement;
  private errorEl: HTMLElement;

  constructor(private readonly init: DeferredViewInit) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "deferred-view-placeholder";

    const title = document.createElement("div");
    title.className = "deferred-view-title";
    title.textContent = this.getDisplayText();

    this.messageEl = document.createElement("div");
    this.messageEl.className = "deferred-view-message";
    this.messageEl.textContent = DEFAULT_MESSAGE;

    this.errorEl = document.createElement("div");
    this.errorEl.className = "deferred-view-error";
    this.errorEl.hidden = true;

    this.containerEl.append(title, this.messageEl, this.errorEl);
  }

  /** Impersonates the persisted type — see the class doc comment. */
  get viewType(): string {
    return this.init.type;
  }

  /** Returned by identity so a still-deferred leaf re-serializes byte-identically. */
  getState(): unknown {
    return this.init.state;
  }

  getDisplayText(): string {
    return this.init.title ?? this.init.type;
  }

  getIcon(): string {
    return this.init.icon ?? "puzzle";
  }

  /**
   * Record why a hydration attempt failed, without giving up the state. The
   * leaf stays deferred and retries on the next launch or re-register, so one
   * bad persisted state can't cost the user the pane permanently.
   */
  setError(message: string): void {
    this.errorEl.textContent = message;
    this.errorEl.hidden = false;
  }

  onOpen(): void {}
  onClose(): void {}
}

/** Type guard — the one place anything needs to know a view is a placeholder. */
export function isDeferredView(view: View | null | undefined): view is DeferredView {
  return view instanceof DeferredView;
}
