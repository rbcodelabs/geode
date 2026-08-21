export const ARTIFACT_SCHEME = "geode-artifact";

export const STATIC_ARTIFACT_CSP = [
  "default-src 'none'",
  `script-src ${ARTIFACT_SCHEME}:`,
  `style-src ${ARTIFACT_SCHEME}: 'unsafe-inline'`,
  `img-src ${ARTIFACT_SCHEME}: data: blob:`,
  `font-src ${ARTIFACT_SCHEME}: data:`,
  `media-src ${ARTIFACT_SCHEME}: blob:`,
  "connect-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

export type ArtifactUrlUse = "document" | "subresource";

export function isArtifactUrlAllowed(rawUrl: string, artifactId: string, use: ArtifactUrlUse): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol === `${ARTIFACT_SCHEME}:`) {
    return url.hostname === artifactId && url.username === "" && url.password === "";
  }
  if (use === "subresource" && ["data:", "blob:"].includes(url.protocol)) return true;
  return false;
}
