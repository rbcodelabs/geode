import type { App } from "../app";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, TFile, VIDEO_EXTENSIONS } from "../types";

/**
 * Embed resolution shared by Reading view (render.ts) and Live Preview
 * (live-preview.ts's EmbedWidget) so both render `![[target]]` the same way.
 */
export type EmbedKind = "image" | "audio" | "video" | "note" | "unresolved" | "other";

export interface ResolvedEmbed {
  kind: EmbedKind;
  /** null only when kind === "unresolved". */
  file: TFile | null;
  /** "#Heading" portion of the link target, or "" if none. Note: only plain
   *  #Heading subpaths are extracted here — #^blockid embeds are out of
   *  scope, matching Reading view (see extractSection's caller). */
  subpath: string;
}

export function resolveEmbed(target: string, sourcePath: string, app: App): ResolvedEmbed {
  const file = app.metadataCache.getFirstLinkpathDest(target, sourcePath);
  const hashIdx = target.indexOf("#");
  const subpath = hashIdx === -1 ? "" : target.slice(hashIdx);
  if (!file) return { kind: "unresolved", file: null, subpath };
  if (IMAGE_EXTENSIONS.has(file.extension)) return { kind: "image", file, subpath };
  if (AUDIO_EXTENSIONS.has(file.extension)) return { kind: "audio", file, subpath };
  if (VIDEO_EXTENSIONS.has(file.extension)) return { kind: "video", file, subpath };
  if (file.extension === "md") return { kind: "note", file, subpath };
  return { kind: "other", file, subpath };
}

/** Parses the `![[image.png|100x50]]` size parameter into width/height. */
export function parseEmbedDims(param: string): { width?: string; height?: string } {
  const m = param.match(/^(\d+)(?:x(\d+))?$/);
  if (!m) return {};
  return { width: m[1], height: m[2] };
}

/** Reads a binary file from the vault and returns a blob: URL for it. */
export async function loadEmbedBlobUrl(app: App, file: TFile): Promise<string> {
  const buf = await app.vault.readBinary(file);
  return URL.createObjectURL(new Blob([buf]));
}

/** Extract the section under a given heading (until the next heading of <= level). */
export function extractSection(text: string, heading: string): string {
  const lines = text.split("\n");
  const target = heading.toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?$/);
    if (m && m[2].trim().toLowerCase() === target) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return text;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})[ \t]/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}
