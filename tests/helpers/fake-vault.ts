import { Events } from "../../src/renderer/events";
import { pathParent, pathName, splitExt, TFile } from "../../src/renderer/types";
import type { Vault } from "../../src/renderer/vault";

/**
 * Minimal in-memory stand-in for `Vault`, shaped to satisfy everything
 * `MetadataCache` calls on it: `getMarkdownFiles`, `getFiles`,
 * `getFileByPath`, `cachedRead`, `getCachedContent`, and the `Events`
 * `on`/`trigger` surface.
 *
 * `Vault` has private fields, so TypeScript won't structurally accept a
 * plain object in its place — this class extends the same `Events` base
 * and is cast to `Vault` at the call site, which is standard practice for
 * testing a collaborator that talks to Electron/IPC in production.
 */
export class FakeVault extends Events {
  private files = new Map<string, { content: string; mtime: number; ctime: number; size: number }>();

  constructor(initialFiles: Record<string, string> = {}) {
    super();
    for (const [path, content] of Object.entries(initialFiles)) this.setFile(path, content);
  }

  setFile(path: string, content: string, times?: { mtime?: number; ctime?: number }) {
    const existing = this.files.get(path);
    const now = Date.now();
    this.files.set(path, {
      content,
      mtime: times?.mtime ?? now,
      ctime: times?.ctime ?? existing?.ctime ?? now,
      size: content.length,
    });
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
      ctime: entry.ctime,
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
    if (!entry) {
      // Mirrors the real shape of an ipcRenderer.invoke rejection: Electron
      // wraps the main-process error's message (and only its message —
      // custom properties like `.code` are dropped across the IPC boundary).
      throw new Error(
        `Error invoking remote method 'vault-read': Error: ENOENT: no such file or directory, open '${file.path}'`
      );
    }
    return entry.content;
  }

  getCachedContent(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  asVault(): Vault {
    return this as unknown as Vault;
  }
}
