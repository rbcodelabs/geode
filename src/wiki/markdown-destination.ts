/** Parser-free destination decoding shared by host and worker analysis. */
export const unescapeMarkdownPunctuation = (text: string) => text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
export function decodeMarkdownDestination(raw: string): string {
  const value = unescapeMarkdownPunctuation(raw.replace(/^<([\s\S]*)>$/, "$1"));
  try { return decodeURI(value); } catch { return value; }
}
