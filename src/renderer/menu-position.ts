export type MenuHorizontalAlign = "start" | "end";

type Rect = { left: number; top: number; right: number; bottom: number };
type Size = { width: number; height: number };

export interface AnchoredMenuPositionOptions {
  anchor: Rect;
  menu: Size;
  viewport: Size;
  margin: number;
  gap: number;
  horizontalAlign: MenuHorizontalAlign;
}

function clampToViewport(value: number, menuSize: number, viewportSize: number, margin: number): number {
  const maximum = viewportSize - menuSize - margin;
  if (maximum <= margin) return margin;
  return Math.max(margin, Math.min(value, maximum));
}

/** Position an anchored dropdown without overlapping its trigger when either side has room. */
export function computeAnchoredMenuPosition(options: AnchoredMenuPositionOptions): { left: number; top: number } {
  const { anchor, menu, viewport, margin, gap, horizontalAlign } = options;
  const preferredLeft = horizontalAlign === "end" ? anchor.right - menu.width : anchor.left;
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - menu.height;
  const top = below + menu.height <= viewport.height - margin ? below : above;

  return {
    left: clampToViewport(preferredLeft, menu.width, viewport.width, margin),
    top: clampToViewport(top, menu.height, viewport.height, margin),
  };
}
