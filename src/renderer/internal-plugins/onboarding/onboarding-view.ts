import { ItemView } from "../../api/obsidian";
import type { WorkspaceLeaf } from "../../workspace";
import { DEFAULT_GROUP } from "./completeness";
import { ONBOARDING_VIEW_TYPE, type OnboardingItem, type OnboardingPlugin } from "./onboarding-plugin";

/**
 * Side-pane checklist. Pure presentation: every decision (score, persistence,
 * checks) lives in `OnboardingPlugin`; this view re-renders on its `onChange`.
 * Text is always set via `textContent` (step titles come from third-party
 * plugins), never as HTML.
 */
export class OnboardingView extends ItemView {
  private off?: () => void;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: OnboardingPlugin) {
    super(leaf);
    this.containerEl.classList.add("mod-show-generic-header");
    this.contentEl.classList.add("onboarding-view");
  }

  getViewType(): string {
    return ONBOARDING_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Onboarding";
  }

  getIcon(): string {
    return "list-checks";
  }

  async onOpen(): Promise<void> {
    this.addAction("refresh-cw", "Re-run checks", () => void this.plugin.refresh());
    this.off = this.plugin.onChange(() => this.render());
    this.render();
    void this.plugin.refresh();
  }

  async onClose(): Promise<void> {
    this.off?.();
    this.off = undefined;
  }

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string,
    parent?: HTMLElement
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    parent?.appendChild(node);
    return node;
  }

  private render(): void {
    const root = this.contentEl;
    root.replaceChildren();
    const snap = this.plugin.getSnapshot();

    if (snap.items.length === 0) {
      const empty = this.el("div", "onboarding-empty", undefined, root);
      this.el("p", "onboarding-empty-title", "No onboarding steps yet", empty);
      this.el("p", "onboarding-empty-hint", "Plugins can recommend steps here as they are installed.", empty);
      return;
    }

    if (snap.dismissedOnboarding) {
      const dismissed = this.el("div", "onboarding-empty", undefined, root);
      this.el("p", "onboarding-empty-title", "Onboarding is hidden", dismissed);
      const show = this.el("button", "onboarding-button", "Show checklist", dismissed);
      show.addEventListener("click", () => void this.plugin.setOnboardingDismissed(false));
      return;
    }

    const { completeness } = snap;
    const summary = this.el("div", "onboarding-summary", undefined, root);
    const label = `${completeness.completed} of ${completeness.total} steps complete`;
    this.el("div", "onboarding-percent", `${completeness.percent}%`, summary);
    this.el("div", "onboarding-summary-label", label, summary);
    const bar = this.el("div", "onboarding-progress", undefined, summary);
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", "Onboarding completeness");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(completeness.percent));
    bar.setAttribute("aria-valuetext", label);
    const fill = this.el("div", "onboarding-progress-fill", undefined, bar);
    fill.style.width = `${completeness.percent}%`;

    // Group by owner, then by group within each owner, preserving registry order.
    const owners = new Map<string, Map<string, OnboardingItem[]>>();
    for (const item of snap.items) {
      const groups = owners.get(item.step.ownerId) ?? new Map<string, OnboardingItem[]>();
      owners.set(item.step.ownerId, groups);
      const g = item.step.group ?? DEFAULT_GROUP;
      groups.set(g, [...(groups.get(g) ?? []), item]);
    }

    for (const [ownerId, groups] of owners) {
      const section = this.el("section", "onboarding-owner", undefined, root);
      const tally = completeness.byOwner[ownerId];
      this.el(
        "h3",
        "onboarding-owner-title",
        tally ? `${this.plugin.ownerName(ownerId)} (${tally.completed}/${tally.total})` : this.plugin.ownerName(ownerId),
        section
      );
      for (const [group, items] of groups) {
        if (groups.size > 1 || group !== DEFAULT_GROUP) this.el("h4", "onboarding-group-title", group, section);
        const list = this.el("ul", "onboarding-steps", undefined, section);
        list.setAttribute("aria-label", `${this.plugin.ownerName(ownerId)}: ${group}`);
        for (const item of items) this.renderStep(list, item);
      }
    }

    const footer = this.el("div", "onboarding-footer", undefined, root);
    const hide = this.el("button", "onboarding-button", "Dismiss onboarding", footer);
    hide.addEventListener("click", () => void this.plugin.setOnboardingDismissed(true));
  }

  private renderStep(list: HTMLElement, item: OnboardingItem): void {
    const { step } = item;
    const li = this.el("li", "onboarding-step", undefined, list);
    li.classList.toggle("is-done", item.done);
    li.classList.toggle("is-skipped", item.skipped);

    const main = this.el("div", "onboarding-step-main", undefined, li);
    const labelEl = this.el("label", "onboarding-step-label", undefined, main);
    const box = this.el("input", "onboarding-checkbox", undefined, labelEl);
    box.type = "checkbox";
    box.checked = item.done;
    const auto = !!step.check;
    // Steps with a dynamic check complete themselves; the box reflects, not drives, them.
    box.disabled = auto;
    const titleText = step.optional ? `${step.title} (optional)` : step.title;
    this.el("span", "onboarding-step-title", titleText, labelEl);
    if (!auto) box.addEventListener("change", () => void this.plugin.toggleStep(step.id));
    if (auto && !item.done) box.title = "Detected automatically";

    if (step.description) this.el("div", "onboarding-step-desc", step.description, main);
    if (!step.ownerEnabled) {
      this.el("div", "onboarding-step-note", "Plugin disabled. Enable it to continue.", main);
    }

    const actions = this.el("div", "onboarding-step-actions", undefined, li);
    if (!step.ownerEnabled) {
      const enable = this.el("button", "onboarding-button", "Enable plugin", actions);
      enable.setAttribute("aria-label", `Enable ${this.plugin.ownerName(step.ownerId)} to continue "${step.title}"`);
      enable.addEventListener("click", () => void this.plugin.enableOwner(step.ownerId));
    } else if (step.commandId && !item.done && this.app.commands.has(step.commandId)) {
      const run = this.el("button", "onboarding-button mod-cta", "Do it", actions);
      run.setAttribute("aria-label", `Do it: ${step.title}`);
      run.addEventListener("click", () => this.plugin.runStep(step.id));
    }
    // Only web links: docsUrl comes from third-party plugins.
    if (step.docsUrl && /^https?:\/\//i.test(step.docsUrl)) {
      const docs = this.el("button", "onboarding-button", "Docs", actions);
      docs.setAttribute("aria-label", `Open documentation: ${step.title}`);
      docs.addEventListener("click", () => this.app.openExternalLink(step.docsUrl!));
    }
    if (!item.done) {
      const skip = this.el("button", "onboarding-button", item.skipped ? "Restore" : "Skip", actions);
      skip.setAttribute("aria-label", `${item.skipped ? "Restore" : "Skip"}: ${step.title}`);
      skip.addEventListener("click", () =>
        void (item.skipped ? this.plugin.unskipStep(step.id) : this.plugin.skipStep(step.id))
      );
    }
  }
}
