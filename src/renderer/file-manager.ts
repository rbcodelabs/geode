import type { App } from "./app";
import { patchFrontmatter } from "./frontmatter-io";
import { isTFile, type TAbstractFile, type TFile, type TFolder } from "./types";
import type { DataWriteOptions, Vault } from "./vault";

const frontmatterQueues = new WeakMap<Vault, Map<string, Promise<void>>>();

function queueFor(vault: Vault): Map<string, Promise<void>> {
  let queue = frontmatterQueues.get(vault);
  if (!queue) {
    queue = new Map();
    frontmatterQueues.set(vault, queue);
  }
  return queue;
}

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
   * processFrontMatter updates in this renderer runtime. The queue is shared
   * by all FileManager instances for the same Vault, but it does not lock out
   * direct Vault.modify calls or external filesystem writers.
   */
  async processFrontMatter(
    file: TFile,
    fn: (frontmatter: any) => void,
    options?: DataWriteOptions,
  ): Promise<void> {
    this.validateFrontmatterFile(file);
    const path = file.path;
    const queue = queueFor(this.app.vault);
    const previous = queue.get(path) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      this.validateFrontmatterFile(file, path);
      await patchFrontmatter(this.app.vault, file, fn, options, () => {
        this.validateFrontmatterFile(file, path);
      });
    });
    const recoveredTail = operation.then(() => undefined, () => undefined);
    queue.set(path, recoveredTail);
    void recoveredTail.then(() => {
      if (queue.get(path) === recoveredTail) queue.delete(path);
    });
    return operation;
  }

  private validateFrontmatterFile(file: TFile, expectedPath = file?.path): void {
    if (!isTFile(file)) {
      throw new Error("FileManager.processFrontMatter requires a Markdown TFile");
    }
    if (file.path !== expectedPath) {
      throw new Error(`Cannot process frontmatter because the file path changed from ${expectedPath}`);
    }
    const current = this.app.vault.getAbstractFileByPath(expectedPath);
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
