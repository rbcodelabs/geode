import { Events } from "../../src/renderer/events";
import { pathParent, pathName, splitExt, TFile } from "../../src/renderer/types";
import type { Vault } from "../../src/renderer/vault";

/**
 * Minimal in-memory stand-in for `Vault`, shaped to satisfy everything
 * `MetadataCache` calls on it: `getMarkdownFiles`, `getFiles`,
 * `getFileByPath`, `cachedRead`, and the `Events` `on`/`trigger` surface.
 *
 * `Vault` has private fields, so TypeScript won't structurally accept a
 * plain object in its place — this class extends the same `Events` base
 * and is cast to `Vault` at the call site, which is standard practice for
 * testing a collaborator that talks to Electron/IPC in production.
 */
export class FakeVault extends Events {
  private files = new Map<string, { content: string; mtime: number; size: number }>();

  constructor(initialFiles: Record<string, string> = {}) {
    super();
    for (const [path, content] of Object.entries(initialFiles)) this.setFile(path, content);
  }

  setFile(path: string, content: string) {
    this.files.set(path, { content, mtime: Date.now(), size: content.length });
  }

  removeFile(path: string) {
    this.files.delete(path);
  }

  private toTFile(path: string): TFile {
    const entry = this.files.get(path)!;
    const name = pathName(path);
    const { basename, extension } = splitExt(name);
    return {
      kind: "file",
      path,
      name,
      basename,
      extension,
      mtime: entry.mtime,
      size: entry.size,
      parent: pathParent(path),
    };
  }

  getFileByPath(path: string): TFile | null {
    return this.files.has(path) ? this.toTFile(path) : null;
  }

  getFiles(): TFile[] {
    return [...this.files.keys()].map((p) => this.toTFile(p));
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === "md");
  }

  async cachedRead(file: TFile): Promise<string> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`No such file: ${file.path}`);
    return entry.content;
  }

  asVault(): Vault {
    return this as unknown as Vault;
  }
}
