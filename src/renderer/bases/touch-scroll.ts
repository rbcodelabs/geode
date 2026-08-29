export type TouchScrollAxis = "pending" | "x" | "y";

export function resolveTouchScrollAxis(dx: number, dy: number, threshold = 6): TouchScrollAxis {
  if (Math.hypot(dx, dy) < threshold) return "pending";
  return Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
}
