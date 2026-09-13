export function isPortableAssetPath(value: string): boolean {
  const parts = value.split("/");
  if (value !== value.normalize("NFC") || parts.some(part => !part || part.startsWith(".") || /[\\\x00-\x1f:*?"<>|]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return false;
  return parts[0] === "themes" && parts.length <= 4 || parts[0] === "snippets" && (parts.length === 1 || parts.length === 2 && parts[1].endsWith(".css"));
}
