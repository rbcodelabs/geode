import moment from "moment";
import type { ConfigService } from "./host/contracts";

/** Obsidian's default for the "Unique note creator" core plugin's prefix format. */
const DEFAULT_FORMAT = "YYYYMMDDHHmm";
/** Upper bound on collision probing, in seconds (two hours of timestamps). */
const MAX_PROBE_SECONDS = 7200;

export interface UniqueNoteSettings {
  /** Vault-relative folder new unique notes are created in. "" = vault root. */
  folder: string;
  /** Moment.js format for the note's filename (minus extension), same tokens as Daily notes. */
  format: string;
  /** Vault-relative path to a template note applied to each new unique note. "" = empty note. */
  template: string;
}

export interface UniqueNotesConfig extends UniqueNoteSettings {
  enabled: boolean;
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Validate persisted Unique note creator config one field at a time, applying defaults. */
export function resolveUniqueNotesConfig(raw: unknown): UniqueNotesConfig {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    folder: text(record, "folder").replace(/^\/+|\/+$/g, ""),
    format: text(record, "format") || DEFAULT_FORMAT,
    template: text(record, "template"),
  };
}

/**
 * Vault-relative path for a unique note stamped at `now`. If that path is
 * taken, advance to the next timestamp that yields an unused name (spec:
 * "the new note uses the next available timestamp").
 */
export function uniqueNotePath(
  now: moment.Moment,
  settings: UniqueNoteSettings,
  exists: (path: string) => boolean
): { path: string; name: string; time: moment.Moment } {
  const prefix = settings.folder ? `${settings.folder}/` : "";
  const seen = new Set<string>();
  for (let offset = 0; offset <= MAX_PROBE_SECONDS; offset++) {
    const time = now.clone().add(offset, "seconds");
    const name = time.format(settings.format);
    if (seen.has(name)) continue;
    seen.add(name);
    const path = `${prefix}${name}.md`;
    if (!exists(path)) return { path, name, time };
  }
  throw new Error("Could not find an unused unique note name. Check the Unique note creator format.");
}

export class UniqueNotesService {
  enabled = true;
  readonly options: UniqueNoteSettings = { folder: "", format: DEFAULT_FORMAT, template: "" };
  private pendingUpdate: Promise<void> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  async load(): Promise<void> {
    this.apply(resolveUniqueNotesConfig(await this.config.read("unique-notes")));
  }

  update(patch: Partial<UniqueNotesConfig>): Promise<void> {
    const operation = this.pendingUpdate.then(async () => {
      const next = resolveUniqueNotesConfig({ enabled: this.enabled, ...this.options, ...patch });
      await this.config.write("unique-notes", next);
      this.apply(next);
    });
    this.pendingUpdate = operation.catch(() => {});
    return operation;
  }

  private apply(config: UniqueNotesConfig): void {
    this.enabled = config.enabled;
    Object.assign(this.options, { folder: config.folder, format: config.format, template: config.template });
  }
}
