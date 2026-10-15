import type { App } from "./app";
import { patchFrontmatter } from "./frontmatter-io";
import { isTFile, type TAbstractFile, type TFile, type TFolder } from "./types";
import type { DataWriteOptions, Vault } from "./vault";

/**
 * Non-visual file operations exposed to hosted plugins. Preference-dependent
 * attachment placement remains intentionally outside this bounded
 * implementation.
 */
export class FileManager {
  constructor(private app: App) {}

  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    if (isTFile(file)) await this.app.renameFileWithLinkUpdate(file, newPath);
    else await this.app.vault.rename(file as TFolder, newPath);
  }

  async trashFile(file: TAbstractFile): Promise<void> {
    await this.app.vault.trash(file as TFile | TFolder);
  }

  generateMarkdownLink(file: TFile, sourcePath: string, subpath = "", alias = ""): string {
    const linktext = this.app.metadataCache.fileToLinktext(file, sourcePath, true);
    return `[[${linktext}${subpath}${alias ? `|${alias}` : ""}]]`;
  }

  /**
   * Mutate a Markdown file's YAML frontmatter without losing concurrent
   * frontmatter helper updates in this renderer runtime. The lane is shared
   * by all helper callers for the same Vault, but it does not lock out
   * direct Vault.modify calls or external filesystem writers.
   */
  async processFrontMatter(
    file: TFile,
    fn: (frontmatter: any) => void,
    options?: DataWriteOptions,
  ): Promise<void> {
    const vault = this.app.vault;
    const path = file?.path;
    this.validateFrontmatterFile(vault, file, path);
    return patchFrontmatter(vault, file, fn, options, () => {
      this.validateFrontmatterFile(vault, file, path);
    });
  }

  private validateFrontmatterFile(vault: Vault, file: TFile, expectedPath: string): void {
    if (this.app.vault !== vault) throw new Error("Cannot process frontmatter because the current vault changed");
    if (!isTFile(file)) {
      throw new Error("FileManager.processFrontMatter requires a Markdown TFile");
    }
    if (file.path !== expectedPath) {
      throw new Error(`Cannot process frontmatter because the file path changed from ${expectedPath}`);
    }
    const current = vault.getAbstractFileByPath(expectedPath);
    if (!current) {
      throw new Error(`Cannot process frontmatter because the file does not exist in the current vault: ${expectedPath}`);
    }
    if (current !== file) {
      throw new Error(`Cannot process frontmatter for a stale or foreign file object outside the current vault: ${expectedPath}`);
    }
    if (file.extension !== "md") {
      throw new Error(`FileManager.processFrontMatter only supports Markdown files: ${expectedPath}`);
    }
  }
}
