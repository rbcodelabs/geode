import moment from "moment";
import type { ConfigService } from "./host/contracts";
import type { TFile } from "./types";
import { renamePathForBasename } from "./rename";

export interface TemplateSettings {
  folder: string;
  dateFormat: string;
  timeFormat: string;
}
export interface TemplatesConfig extends TemplateSettings {
  enabled: boolean;
}

export function templateNoteName(rawName: string): string {
  const name = rawName.trim().replace(/\.md$/i, "").trim();
  const validated = renamePathForBasename("Untitled.md", name);
  if (!validated.ok || /^\.+$/.test(name) || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error("Invalid file name");
  }
  return name;
}

export function resolveTemplatesConfig(raw: unknown): TemplatesConfig {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const format = (key: string, fallback: string) => typeof record[key] === "string" ? record[key].trim() || fallback : fallback;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    folder: typeof record.folder === "string" ? record.folder.trim().replace(/^\/+|\/+$/g, "") : "Templates",
    dateFormat: format("dateFormat", "YYYY-MM-DD"),
    timeFormat: format("timeFormat", "HH:mm"),
  };
}
export function renderTemplate(
  content: string,
  title: string,
  now: moment.Moment,
  formats: Pick<TemplateSettings, "dateFormat" | "timeFormat"> = resolveTemplatesConfig(null)
): string {
  // One pass keeps variable-looking text in titles from being expanded again.
  return content.replace(/\{\{(title|date|time)(?::([\s\S]*?))?\}\}/g, (token, variable: string, format: string | undefined) => {
    if (variable === "title") return format === undefined ? title : token;
    return now.format(format || (variable === "date" ? formats.dateFormat : formats.timeFormat));
  });
}
export function templatePath(path: string): string {
  const trimmed = path.trim();
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}
export function templateFiles(files: TFile[], folder: string): TFile[] {
  const prefix = folder ? `${folder}/` : "";
  return files.filter(file => file.extension === "md" && file.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path));
}
export class TemplatesService {
  enabled = true;
  readonly options: TemplateSettings = { folder: "Templates", dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" };
  private pendingUpdate: Promise<void> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  async load(): Promise<void> {
    this.apply(resolveTemplatesConfig(await this.config.read("templates")));
  }

  update(patch: Partial<TemplatesConfig>): Promise<void> {
    const operation = this.pendingUpdate.then(async () => {
      const next = resolveTemplatesConfig({ enabled: this.enabled, ...this.options, ...patch });
      await this.config.write("templates", next);
      this.apply(next);
    });
    this.pendingUpdate = operation.catch(() => {});
    return operation;
  }

  private apply(config: TemplatesConfig): void {
    this.enabled = config.enabled;
    Object.assign(this.options, { folder: config.folder, dateFormat: config.dateFormat, timeFormat: config.timeFormat });
  }
}
