import moment from "moment";
import type { TFile } from "./types";

/** Obsidian's own defaults for the "Daily notes" core plugin's settings. */
const DEFAULT_FORMAT = "YYYY-MM-DD";
const DEFAULT_FOLDER = "";
const DEFAULT_TEMPLATE = "";

export interface DailyNoteSettings {
  /** Vault-relative folder daily notes live in/are created in. "" = vault root. */
  folder: string;
  /** Moment.js format for the note's filename (minus extension). `/` nests into folders. */
  format: string;
  /** Vault-relative path to a template note applied to newly created daily notes. */
  template: string;
}

/**
 * Resolve raw (possibly partial/unset) persisted daily-notes config into a
 * fully-populated settings object, applying Obsidian's own defaults for any
 * missing field. Mirrors how the real "daily-notes" internal plugin reports
 * its `options` (`format`/`folder`/`template`, empty string when unset) —
 * this is also the exact shape `obsidian-daily-notes-interface` (bundled
 * into community plugins like Calendar) reads off
 * `internalPlugins.getPluginById("daily-notes").instance.options`.
 */
export function resolveDailyNoteSettings(
  raw: Partial<DailyNoteSettings> | null | undefined
): DailyNoteSettings {
  const folder = raw?.folder?.trim();
  const format = raw?.format?.trim();
  const template = raw?.template?.trim();
  return {
    folder: folder ? folder.replace(/^\/+/, "").replace(/\/+$/, "") : DEFAULT_FOLDER,
    format: format ? format : DEFAULT_FORMAT,
    template: template ? template : DEFAULT_TEMPLATE,
  };
}

/**
 * Index `files` into a lookup of daily notes keyed by the moment-formatted
 * date string (per `settings.format`) each one represents.
 *
 * A file matches if it lives under `settings.folder` (directly or nested)
 * and its path *relative to that folder*, minus extension, strictly parses
 * against `settings.format` with moment — this is what makes nested-folder
 * formats like `YYYY/MMMM/YYYY-MMM-DD` work: the folder segments (`2024`,
 * `January`) are part of the match, not just the filename.
 */
export function matchDailyNoteFile(files: TFile[], settings: DailyNoteSettings): Map<string, TFile> {
  const map = new Map<string, TFile>();
  const folder = settings.folder;
  const prefix = folder ? `${folder}/` : "";
  for (const file of files) {
    if (prefix && !file.path.startsWith(prefix)) continue;
    const relativePath = prefix ? file.path.slice(prefix.length) : file.path;
    const relativeNoExt = relativePath.replace(/\.[^/.]+$/, "");
    const parsed = moment(relativeNoExt, settings.format, true);
    if (!parsed.isValid()) continue;
    map.set(parsed.format(settings.format), file);
  }
  return map;
}

/** Vault-relative path a daily note for `date` would be created at, given `settings`. */
export function dailyNotePath(date: moment.Moment, settings: DailyNoteSettings): string {
  const filename = `${date.format(settings.format)}.md`;
  return settings.folder ? `${settings.folder}/${filename}` : filename;
}
