import type { ArtifactCommentStatus } from "../../artifacts/feedback-contract-v2";
import { PIN_BADGE } from "./pin-collapse";

/**
 * The pin layer (design 3.4, 3.7): plain embedder DOM above the artifact stage, one `<button>` per badge. Everything
 * that came from a page or a comments file (`text`, `label`) is placed with `textContent` / setAttribute only; no HTML
 * string is ever parsed here. Positions are applied by `transform` (one write per badge per render), never by layout.
 *
 * Keyboard: the layer is one tab stop (roving tabindex). Arrow keys move through the badges in reading order, Home and
 * End jump, Enter and Space activate (a button click), Esc hands focus back (the view decides where).
 */

export interface PinBadgeView {
  readonly key: string;
  readonly kind: "pin" | "cluster";
  /** Comment ids this badge stands for (one for a pin). */
  readonly ids: readonly string[];
  /** Centre of the badge, stage-relative px. */
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly label: string;
  readonly status: ArtifactCommentStatus;
  readonly approximate: boolean;
  readonly z: number;
}

export interface PinOverlayCallbacks {
  onActivate(badge: { key: string; kind: "pin" | "cluster"; ids: readonly string[] }): void;
  onEscape(): void;
}

/** The roving-focus target for a navigation key, or null when the key is not a navigation key. */
export function nextBadgeIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown": return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp": return (current - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

export class PinOverlay {
  readonly el: HTMLElement;
  private readonly nodes = new Map<string, HTMLButtonElement>();
  private order: string[] = [];
  private activeKey: string | null = null;
  private views = new Map<string, PinBadgeView>();

  constructor(private readonly doc: Document, private readonly callbacks: PinOverlayCallbacks) {
    this.el = doc.createElement("div");
    this.el.className = "pin-layer";
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", "Comment pins");
    this.el.hidden = true;
    this.el.addEventListener("keydown", (event) => this.onKeydown(event));
  }

  render(badges: readonly PinBadgeView[], options: { busy: boolean }): void {
    const focusedKey = this.keyOf(this.doc.activeElement);
    const previousOrder = this.order;
    this.views = new Map(badges.map((b) => [b.key, b]));
    this.order = badges.map((b) => b.key);
    this.el.hidden = badges.length === 0;
    this.el.setAttribute("aria-busy", String(options.busy));
    this.el.classList.toggle("is-busy", options.busy);

    for (const [key, node] of this.nodes) {
      if (!this.views.has(key)) { node.remove(); this.nodes.delete(key); }
    }
    const radius = PIN_BADGE.diameter / 2;
    for (const badge of badges) {
      let node = this.nodes.get(badge.key);
      if (!node) {
        node = this.doc.createElement("button");
        node.type = "button";
        node.dataset.key = badge.key;
        node.addEventListener("click", () => {
          const view = this.views.get(badge.key);
          if (view) { this.setActive(badge.key); this.callbacks.onActivate({ key: view.key, kind: view.kind, ids: view.ids }); }
        });
        node.addEventListener("focus", () => this.setActive(badge.key));
        this.nodes.set(badge.key, node);
      }
      node.className = `pin-badge is-${badge.kind} is-${badge.status}${badge.approximate ? " is-approximate" : ""}`;
      node.style.transform = `translate(${round2(badge.x - radius)}px, ${round2(badge.y - radius)}px)`;
      node.style.zIndex = String(badge.z);
      node.setAttribute("aria-label", badge.label);
      this.fill(node, badge);
    }
    // Reading order is DOM order, so Tab and the arrow keys agree.
    const ordered = this.order.map((key) => this.nodes.get(key)!);
    ordered.forEach((node, i) => { if (this.el.children[i] !== node) this.el.insertBefore(node, this.el.children[i] ?? null); });

    if (this.activeKey === null || !this.views.has(this.activeKey)) {
      // The roving stop fell off: take the nearest neighbour of where it was.
      const was = this.activeKey === null ? -1 : previousOrder.indexOf(this.activeKey);
      this.activeKey = this.order[Math.min(Math.max(was, 0), this.order.length - 1)] ?? null;
    }
    this.syncTabStops();
    if (focusedKey !== null && !this.views.has(focusedKey) && this.activeKey !== null) this.nodes.get(this.activeKey)?.focus();
  }

  /** Focuses the badge standing for a comment (a pin, or a cluster that contains it). */
  focusBadge(id: string): boolean {
    for (const view of this.views.values()) {
      if (view.ids.includes(id)) { const node = this.nodes.get(view.key); if (node) { node.focus(); return true; } }
    }
    return false;
  }

  focusFirst(): boolean {
    const key = this.activeKey ?? this.order[0];
    const node = key ? this.nodes.get(key) : undefined;
    if (!node) return false;
    node.focus();
    return true;
  }

  private fill(node: HTMLButtonElement, badge: PinBadgeView): void {
    const glyph = badge.kind === "pin" && badge.approximate ? `~${badge.text}` : badge.text;
    const check = badge.kind === "pin" && badge.status === "sent";
    const signature = `${glyph}|${check ? "c" : ""}`;
    if (node.dataset.shape === signature) return;
    node.dataset.shape = signature;
    node.replaceChildren(this.doc.createTextNode(glyph));
    if (check) {
      const mark = this.doc.createElement("span");
      mark.className = "pin-badge-check";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = "✓";
      node.append(mark);
    }
  }

  private keyOf(el: Element | null): string | null {
    const node = el as HTMLElement | null;
    return node !== null && node.dataset !== undefined && this.el.contains(node) ? node.dataset.key ?? null : null;
  }

  private setActive(key: string): void {
    if (this.activeKey === key) return;
    this.activeKey = key;
    this.syncTabStops();
  }

  private syncTabStops(): void {
    for (const [key, node] of this.nodes) node.tabIndex = key === this.activeKey ? 0 : -1;
  }

  private onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.onEscape();
      return;
    }
    const current = this.keyOf(event.target as Element);
    if (current === null) return;
    const next = nextBadgeIndex(this.order.indexOf(current), this.order.length, event.key);
    if (next === null) return;
    event.preventDefault();
    const key = this.order[next]!;
    this.setActive(key);
    this.nodes.get(key)?.focus();
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
