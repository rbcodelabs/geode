import moment from "moment";
import type { TFile } from "./types";
import type { ConfigService } from "./host/contracts";

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

export interface DailyNotesConfig extends DailyNoteSettings {
  enabled: boolean;
}

type DailyNotesConfigUpdate = Partial<DailyNotesConfig>;

function stringField(raw: Record<string, unknown>, key: keyof DailyNoteSettings): string | undefined {
  const value = raw[key];
  return typeof value === "string" ? value : undefined;
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
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const folder = stringField(record, "folder")?.trim();
  const format = stringField(record, "format")?.trim();
  const template = stringField(record, "template")?.trim();
  return {
    folder: folder ? folder.replace(/^\/+/, "").replace(/\/+$/, "") : DEFAULT_FOLDER,
    format: format ? format : DEFAULT_FORMAT,
    template: template ? template : DEFAULT_TEMPLATE,
  };
}

/** Validate the per-vault persisted lifecycle and options, one field at a time. */
export function resolveDailyNotesConfig(raw: unknown): DailyNotesConfig {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    ...resolveDailyNoteSettings(record as Partial<DailyNoteSettings>),
  };
}

/**
 * Single per-vault owner for Daily Notes lifecycle, persisted settings, and
 * the live `instance.options` object exposed to hosted Obsidian plugins.
 */
export class DailyNotesService {
  enabled = true;
  readonly options: DailyNoteSettings = resolveDailyNoteSettings(null);
  private pendingUpdate: Promise<void> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  async load(): Promise<void> {
    const resolved = resolveDailyNotesConfig(await this.config.read("daily-notes"));
    this.apply(resolved);
  }

  update(patch: DailyNotesConfigUpdate): Promise<void> {
    const operation = this.pendingUpdate.then(async () => {
      const next = resolveDailyNotesConfig({
        enabled: this.enabled,
        ...this.options,
        ...patch,
      });
      await this.config.write("daily-notes", next);
      this.apply(next);
    });
    this.pendingUpdate = operation.catch(() => {});
    return operation;
  }

  private apply(config: DailyNotesConfig): void {
    this.enabled = config.enabled;
    Object.assign(this.options, {
      folder: config.folder,
      format: config.format,
      template: config.template,
    });
  }
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
