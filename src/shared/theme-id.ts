export function assertValidThemeId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !id || id === "." || id === ".." || /[\\/\0]/.test(id)) {
    throw new Error("Invalid theme id");
  }
}
