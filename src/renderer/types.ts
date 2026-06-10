import type { GeodeApi } from "../main/preload";

declare global {
  interface Window {
    geode: GeodeApi;
  }
}

export interface TAbstractFile {
  path: string;
  name: string;
}

export interface TFile extends TAbstractFile {
  kind: "file";
  basename: string;
  extension: string;
  mtime: number;
  size: number;
  parent: string; // folder path, "" for root
}

export interface TFolder extends TAbstractFile {
  kind: "folder";
  parent: string;
  children: TAbstractFile[];
}

export interface Pos {
  line: number;
  ch: number;
  offset: number;
}

export interface Loc {
  start: Pos;
  end: Pos;
}

export interface LinkCache {
  link: string; // raw link target, e.g. "Note#Heading"
  displayText: string;
  position: Loc;
  isEmbed: boolean;
}

export interface TagCache {
  tag: string; // without '#'
  position: Loc;
}

export interface HeadingCache {
  heading: string;
  level: number;
  position: Loc;
}

export interface CachedMetadata {
  frontmatter: Record<string, unknown> | null;
  frontmatterEndOffset: number;
  links: LinkCache[];
  embeds: LinkCache[];
  tags: TagCache[];
  headings: HeadingCache[];
  aliases: string[];
}

export const MARKDOWN_EXTENSIONS = new Set(["md"]);
export const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
export const AUDIO_EXTENSIONS = new Set(["flac", "m4a", "mp3", "ogg", "wav", "3gp"]);
export const VIDEO_EXTENSIONS = new Set(["mkv", "mov", "mp4", "ogv", "webm"]);

export function pathParent(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

export function pathName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

export function splitExt(name: string): { basename: string; extension: string } {
  const i = name.lastIndexOf(".");
  if (i <= 0) return { basename: name, extension: "" };
  return { basename: name.slice(0, i), extension: name.slice(i + 1).toLowerCase() };
}
