import type { App } from "./app";
import { isTFile, type TAbstractFile, type TFile, type TFolder } from "./types";

/**
 * Non-visual file operations exposed to hosted plugins. Preference-dependent
 * attachment placement and atomic frontmatter editing remain intentionally
 * outside this bounded implementation.
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
}
