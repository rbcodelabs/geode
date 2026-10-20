import type { LaunchRunner, LaunchSnapshot, LaunchStepState } from "./launch-sequence";

/** Nothing is shown unless the sequence is still running after this long (avoids a flash). */
export const LAUNCH_OVERLAY_DELAY_MS = 300;
const FADE_MS = 220;

export interface LaunchOverlayOptions {
  /** The first-time screen's gem chip markup (App.brandChipHtml) so the look is shared, not forked. */
  brandChipHtml: string;
  vaultName?: string;
  /** Never show anything (tests). The overlay never takes focus, so headless/e2e leave it enabled. */
  disabled?: boolean;
  delayMs?: number;
}

const STATUS_LABEL: Record<LaunchStepState["status"], string> = {
  pending: "Waiting",
  running: "In progress",
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
};

/**
 * Progress bar + step list markup shared by the launch screen and the Vault Hub's
 * morphed card. Deliberately has no Skip button: the owner appends one only when a
 * runner is attached (see SKIP_BUTTON_HTML), so a pre-launch card has nothing to click.
 */
export const LAUNCH_PANEL_HTML =
  `<p class="launch-overlay-subtitle"></p>` +
  `<div class="launch-overlay-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="launch-overlay-progress-bar"></div></div>` +
  `<ul class="launch-overlay-steps"></ul>`;

export const SKIP_BUTTON_HTML = `<div class="launch-overlay-actions"><button type="button" class="vault-picker-external launch-overlay-skip" hidden>Skip</button></div>`;

/** Paint a runner snapshot into any element containing LAUNCH_PANEL_HTML. */
export function renderLaunchPanel(root: HTMLElement, snap: LaunchSnapshot, vaultName?: string): void {
  const active = snap.steps.find((s) => s.id === snap.activeStepId);
  root.querySelector<HTMLElement>(".launch-overlay-subtitle")!.textContent =
    vaultName ? `Opening ${vaultName}…` : "Opening your vault…";

  const pct = Math.round((snap.progress + (active?.fraction ?? 0) / Math.max(1, snap.steps.length)) * 100);
  const bar = root.querySelector<HTMLElement>(".launch-overlay-progress")!;
  bar.setAttribute("aria-valuenow", String(Math.min(100, pct)));
  root.querySelector<HTMLElement>(".launch-overlay-progress-bar")!.style.width = `${Math.min(100, pct)}%`;

  const list = root.querySelector<HTMLUListElement>(".launch-overlay-steps")!;
  list.textContent = "";
  for (const step of snap.steps) {
    const li = document.createElement("li");
    li.className = `launch-overlay-step is-${step.status}`;
    const mark = document.createElement("span");
    mark.className = "vault-picker-dot launch-overlay-mark";
    mark.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "launch-overlay-step-text";
    const title = document.createElement("span");
    title.className = "launch-overlay-step-title";
    title.textContent = step.title;
    text.appendChild(title);
    const detail = step.status === "running"
      ? step.detail ?? step.description
      : step.status === "pending"
        ? step.description
        : step.status === "done" ? undefined : step.detail;
    if (detail) {
      const d = document.createElement("span");
      d.className = "launch-overlay-step-detail";
      d.textContent = detail;
      text.appendChild(d);
    }
    const status = document.createElement("span");
    status.className = "launch-overlay-step-status";
    status.textContent = STATUS_LABEL[step.status];
    li.append(mark, text, status);
    list.appendChild(li);
  }

  const skip = root.querySelector<HTMLButtonElement>(".launch-overlay-skip");
  if (skip) {
    skip.hidden = !(active && active.optional);
    skip.textContent = active ? `Skip “${active.title}”` : "Skip";
  }
}

/**
 * Launch screen. Reuses the `.vault-picker` surface, lockup and chip; the
 * overlay-specific rules in app.css are only layout (fixed, fade, step list).
 * It never takes focus.
 */
export class LaunchOverlay {
  private el: HTMLElement | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private dismissed = false;

  constructor(private readonly runner: LaunchRunner, private readonly opts: LaunchOverlayOptions) {}

  /** Begin watching the runner; the overlay appears after the delay if work is still going. */
  start(): void {
    if (this.opts.disabled || typeof document === "undefined") return;
    this.unsubscribe = this.runner.onChange(() => this.render());
    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      if (!this.dismissed && this.hasWork(this.runner.getSnapshot())) this.mount();
    }, this.opts.delayMs ?? LAUNCH_OVERLAY_DELAY_MS);
  }

  /** Fade out and remove. Safe to call repeatedly or before it ever showed. */
  dismiss(): void {
    this.dismissed = true;
    if (this.showTimer) clearTimeout(this.showTimer);
    this.showTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const el = this.el;
    this.el = null;
    if (!el) return;
    el.classList.remove("is-visible");
    const remove = () => el.remove();
    // Fall back to a timer: transitionend never fires under reduced motion / display:none.
    setTimeout(remove, FADE_MS + 50);
  }

  private hasWork(snap: LaunchSnapshot): boolean {
    return snap.steps.some((s) => s.status === "running" || s.status === "pending");
  }

  private mount(): void {
    const el = document.createElement("div");
    el.className = "vault-picker launch-overlay";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-label", "Opening vault");
    el.innerHTML =
      `<div class="vault-picker-lockup">${this.opts.brandChipHtml}<h1>Geode</h1></div>` +
      LAUNCH_PANEL_HTML + SKIP_BUTTON_HTML;
    el.querySelector<HTMLButtonElement>(".launch-overlay-skip")!.addEventListener("click", () => this.runner.skipActive());
    document.body.appendChild(el);
    this.el = el;
    this.render();
    // Next frame so the opacity transition runs.
    requestAnimationFrame(() => el.classList.add("is-visible"));
  }

  private render(): void {
    if (this.el) renderLaunchPanel(this.el, this.runner.getSnapshot(), this.opts.vaultName);
  }
}
