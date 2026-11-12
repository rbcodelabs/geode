/** Freezes plain objects and arrays recursively; typed arrays (the screenshot bytes) cannot be frozen and are left alone. */
export function freezePlain<T>(value: T): T {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) freezePlain((value as Record<string, unknown>)[key]);
  return Object.freeze(value);
}
