/**
 * Map a BCP 47 locale (`navigator.language`) onto the language codes
 * Obsidian's `getLanguage()` returns: a bare language ("en", "de") except for
 * the two families Obsidian ships regional variants of (zh-TW, pt-BR).
 * Anything unusable falls back to "en".
 */
export function resolveLanguageCode(locale: string | undefined | null): string {
  if (!locale) return "en";
  const [language, ...rest] = locale.replace(/_/g, "-").split("-");
  const base = language.toLowerCase();
  if (!/^[a-z]{2,3}$/.test(base)) return "en";
  const subtags = rest.map((part) => part.toUpperCase());
  if (base === "zh" && (subtags.includes("TW") || subtags.includes("HK") || subtags.includes("HANT"))) return "zh-TW";
  if (base === "pt" && subtags.includes("BR")) return "pt-BR";
  return base;
}
