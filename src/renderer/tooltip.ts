/**
 * A global, delegated tooltip layer for any element carrying an `aria-label`.
 *
 * Geode renders no tooltips of its own today: `setTooltip()` (api/obsidian.ts)
 * historically also set the native `title` attribute, which produces the
 * browser's slow, unstyled OS tooltip. This module replaces that with a
 * proper hover affordance so ribbon actions, status bar items, and any
 * plugin-authored element with `aria-label` get a consistent, immediate
 * tooltip — matching Obsidian's own behavior.
 *
 * Positioning is controlled by two optional data attributes on the target:
 *   - `data-tooltip-position`: "top" | "bottom" | "left" | "right" (default "bottom")
 *   - `data-tooltip-delay`: milliseconds before the tooltip appears
 *
 * The tooltip clamps to the viewport, flipping vertically when it would
 * otherwise overflow — e.g. status bar items pinned to the bottom edge flip
 * their tooltip upward automatically.
 */

export type TooltipPosition = "top" | "bottom" | "left" | "right";

const DEFAULT_DELAY_MS = 300;
const VIEWPORT_MARGIN = 4;
const TARGET_GAP = 6;

let tooltipEl: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let currentTarget: HTMLElement | null = null;
let installed = false;

function findTooltipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  return node.closest<HTMLElement>("[aria-label]");
}

function clearShowTimer(): void {
  if (showTimer !== null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

function removeTooltipEl(): void {
  tooltipEl?.remove();
  tooltipEl = null;
}

function hideTooltip(): void {
  clearShowTimer();
  currentTarget = null;
  removeTooltipEl();
}

function computeCoords(
  position: TooltipPosition,
  targetRect: DOMRect,
  tooltipRect: DOMRect
): { top: number; left: number } {
  switch (position) {
    case "top":
      return {
        top: targetRect.top - tooltipRect.height - TARGET_GAP,
        left: targetRect.left + (targetRect.width - tooltipRect.width) / 2,
      };
    case "left":
      return {
        top: targetRect.top + (targetRect.height - tooltipRect.height) / 2,
        left: targetRect.left - tooltipRect.width - TARGET_GAP,
      };
    case "right":
      return {
        top: targetRect.top + (targetRect.height - tooltipRect.height) / 2,
        left: targetRect.right + TARGET_GAP,
      };
    case "bottom":
    default:
      return {
        top: targetRect.bottom + TARGET_GAP,
        left: targetRect.left + (targetRect.width - tooltipRect.width) / 2,
      };
  }
}

/**
 * Position a hover-owned floating element against its trigger and clamp it to
 * the viewport. Page Preview shares this primitive so tooltip and preview
 * cards cannot drift into two subtly different edge-placement systems.
 */
export function positionHoverElement(
  el: HTMLElement,
  target: HTMLElement,
  requested: TooltipPosition = "bottom"
): void {
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = el.getBoundingClientRect();

  let position = requested;
  let coords = computeCoords(position, targetRect, tooltipRect);

  // Flip vertically if the tooltip would overflow the viewport on that edge —
  // e.g. a status bar item pinned to the bottom flips its "bottom" tooltip
  // upward instead of rendering off-screen.
  if (position === "bottom" && coords.top + tooltipRect.height > window.innerHeight) {
    position = "top";
    coords = computeCoords(position, targetRect, tooltipRect);
  } else if (position === "top" && coords.top < 0) {
    position = "bottom";
    coords = computeCoords(position, targetRect, tooltipRect);
  }

  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(coords.left, window.innerWidth - tooltipRect.width - VIEWPORT_MARGIN)
  );
  const top = Math.max(
    VIEWPORT_MARGIN,
    Math.min(coords.top, window.innerHeight - tooltipRect.height - VIEWPORT_MARGIN)
  );

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function isTooltipPosition(value: string | null): value is TooltipPosition {
  return value === "top" || value === "bottom" || value === "left" || value === "right";
}

function showTooltipFor(target: HTMLElement): void {
  const label = target.getAttribute("aria-label");
  if (!label) return;
  removeTooltipEl();

  const positionAttr = target.getAttribute("data-tooltip-position");
  const position: TooltipPosition = isTooltipPosition(positionAttr) ? positionAttr : "bottom";

  const el = document.createElement("div");
  el.className = "tooltip";
  el.textContent = label;
  document.body.appendChild(el);
  tooltipEl = el;
  positionHoverElement(el, target, position);
}

function scheduleShow(target: HTMLElement): void {
  clearShowTimer();
  currentTarget = target;
  const delayAttr = target.getAttribute("data-tooltip-delay");
  const parsedDelay = delayAttr ? Number(delayAttr) : NaN;
  const delay = Number.isFinite(parsedDelay) ? parsedDelay : DEFAULT_DELAY_MS;
  showTimer = setTimeout(() => {
    showTimer = null;
    if (currentTarget === target) showTooltipFor(target);
  }, delay);
}

/** Install the delegated tooltip listeners on `document`/`document.body`. Idempotent. */
export function initTooltips(): void {
  if (installed) return;
  installed = true;

  document.body.addEventListener("mouseover", (e) => {
    if (document.body.classList.contains("is-mobile")) return;
    const target = findTooltipTarget(e.target);
    if (!target || target === currentTarget) return;
    scheduleShow(target);
  });
  document.body.addEventListener("mouseout", (e) => {
    const target = findTooltipTarget(e.target);
    if (!target || target !== currentTarget) return;
    const related = (e as MouseEvent).relatedTarget;
    if (related instanceof Node && target.contains(related)) return;
    hideTooltip();
  });
  document.body.addEventListener("focusin", (e) => {
    if (document.body.classList.contains("is-mobile")) return;
    const target = findTooltipTarget(e.target);
    if (!target || target === currentTarget) return;
    scheduleShow(target);
  });
  document.body.addEventListener("focusout", (e) => {
    const target = findTooltipTarget(e.target);
    if (!target || target !== currentTarget) return;
    hideTooltip();
  });
  document.addEventListener("scroll", () => hideTooltip(), true);
  document.addEventListener("click", () => hideTooltip(), true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTooltip();
  });
}
