/** Phase1 contract scaffold only. Deliberately incomplete until assertion RED review.
 * Not wired into main/preload/host; must not remain permissive at delivery freeze. */
export function isImageResourceRequest(_operation: "read" | "cancel" | "finish", value: unknown): boolean {
  return typeof value === "object" && value !== null;
}
export function isImageResourceReply(_operation: "read" | "cancel" | "finish", _id: string, value: unknown): boolean {
  return typeof value === "object" && value !== null;
}
