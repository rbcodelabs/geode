import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export type CrashDiagnostic =
  | { type: "renderer-gone"; at: number; reason: string; exitCode: number; activePlugins: string[] }
  | { type: "renderer-hang"; at: number; activePlugins: string[] }
  | { type: "plugin-error"; at: number; pluginId: string; boundary: string; message: string; stack?: string };

/** Machine-local, bounded diagnostics that survive a renderer process crash. */
export class CrashJournal {
  private pending = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxEntries = 50
  ) {}

  read(): CrashDiagnostic[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  append(entry: CrashDiagnostic): Promise<void> {
    // A failed disk write must not permanently poison the queue; later
    // diagnostics should still get a chance to persist after transient errors.
    this.pending = this.pending.catch(() => {}).then(async () => {
      const entries = [...this.read(), entry].slice(-this.maxEntries);
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await fsp.writeFile(tempPath, JSON.stringify(entries, null, 2));
      await fsp.rename(tempPath, this.filePath);
    });
    return this.pending;
  }
}
