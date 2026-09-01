import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { FileManager } from "../../src/renderer/file-manager";
import type { DataWriteOptions } from "../../src/renderer/vault";
import type { TFile, TFolder } from "../../src/renderer/types";

function file(path: string): TFile {
  const name = path.split("/").pop()!;
  const dot = name.lastIndexOf(".");
  return {
    kind: "file",
    path,
    name,
    basename: dot < 0 ? name : name.slice(0, dot),
    extension: dot < 0 ? "" : name.slice(dot + 1).toLowerCase(),
    parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    ctime: 0,
    mtime: 0,
    size: 0,
  };
}

function folder(path: string): TFolder {
  return { kind: "folder", path, name: path, parent: "", children: [] };
}

function fakeApp(initial: Record<string, string>) {
  const files = new Map<string, TFile>();
  const contents = new Map(Object.entries(initial));
  for (const path of contents.keys()) files.set(path, file(path));

  const vault = {
    getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
    read: vi.fn(async (target: TFile) => contents.get(target.path)!),
    modify: vi.fn(async (target: TFile, data: string, _options?: DataWriteOptions) => {
      contents.set(target.path, data);
    }),
  };
  return { app: { vault } as any, vault, files, contents };
}

function readFrontmatter(text: string): Record<string, unknown> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  return parseYaml(match[1]) as Record<string, unknown>;
}

describe("FileManager.processFrontMatter", () => {
  it("exposes the documented three-argument signature", () => {
    const { app } = fakeApp({ "Note.md": "Body\n" });
    const manager = new FileManager(app);
    expect(manager.processFrontMatter.length).toBe(3);
  });

  it("skips Vault.modify for a no-op mutation", async () => {
    const { app, vault, files } = fakeApp({ "Note.md": "---\nstatus: draft\n---\nBody\n" });
    await new FileManager(app).processFrontMatter(files.get("Note.md")!, () => {});
    expect(vault.modify).not.toHaveBeenCalled();
  });

  it("passes DataWriteOptions through to Vault.modify", async () => {
    const { app, vault, files } = fakeApp({ "Note.md": "Body\n" });
    const options = { ctime: 11, mtime: 22 };
    await new FileManager(app).processFrontMatter(files.get("Note.md")!, (fm) => {
      fm.status = "done";
    }, options);
    expect(vault.modify).toHaveBeenCalledWith(files.get("Note.md"), expect.stringContaining("status: done"), options);
  });

  it("serializes concurrent same-path mutations so both survive", async () => {
    const { app, files, contents } = fakeApp({ "Note.md": "Body\n" });
    const manager = new FileManager(app);
    const note = files.get("Note.md")!;

    await Promise.all([
      manager.processFrontMatter(note, (fm) => {
        fm.first = true;
      }),
      manager.processFrontMatter(note, (fm) => {
        fm.second = true;
      }),
    ]);

    expect(readFrontmatter(contents.get("Note.md")!)).toMatchObject({ first: true, second: true });
  });

  it("shares same-path serialization across FileManager instances for one vault", async () => {
    const { app, files, contents } = fakeApp({ "Note.md": "Body\n" });
    const note = files.get("Note.md")!;

    await Promise.all([
      new FileManager(app).processFrontMatter(note, (fm) => { fm.first = true; }),
      new FileManager(app).processFrontMatter(note, (fm) => { fm.second = true; }),
    ]);

    expect(readFrontmatter(contents.get("Note.md")!)).toMatchObject({ first: true, second: true });
  });

  it("continues a path queue after a callback rejects", async () => {
    const { app, vault, files, contents } = fakeApp({ "Note.md": "Body\n" });
    const manager = new FileManager(app);
    const note = files.get("Note.md")!;

    const failed = manager.processFrontMatter(note, () => {
      throw new Error("callback failed");
    });
    const recovered = manager.processFrontMatter(note, (fm) => {
      fm.recovered = true;
    });

    await expect(failed).rejects.toThrow("callback failed");
    await expect(recovered).resolves.toBeUndefined();
    expect(vault.modify).toHaveBeenCalledTimes(1);
    expect(readFrontmatter(contents.get("Note.md")!)).toMatchObject({ recovered: true });
  });

  it("does not let one file block a different file", async () => {
    const { app, vault, files } = fakeApp({ "A.md": "A\n", "B.md": "B\n" });
    let releaseA!: () => void;
    const aBlocked = new Promise<void>((resolve) => { releaseA = resolve; });
    vault.read.mockImplementation(async (target: TFile) => {
      if (target.path === "A.md") await aBlocked;
      return target.path === "A.md" ? "A\n" : "B\n";
    });
    const manager = new FileManager(app);

    const first = manager.processFrontMatter(files.get("A.md")!, (fm) => { fm.a = true; });
    const second = manager.processFrontMatter(files.get("B.md")!, (fm) => { fm.b = true; });
    await expect(second).resolves.toBeUndefined();
    expect(vault.modify).toHaveBeenCalledWith(files.get("B.md"), expect.any(String), undefined);
    releaseA();
    await first;
  });

  it("rejects folders, stale or foreign objects, deleted files, and non-Markdown files before mutation", async () => {
    const { app, vault, files } = fakeApp({ "Note.md": "Body\n", "image.png": "binary-ish" });
    const manager = new FileManager(app);
    const mutate = vi.fn();

    await expect(manager.processFrontMatter(folder("Folder") as any, mutate)).rejects.toThrow(/Markdown TFile/);
    await expect(manager.processFrontMatter(file("Note.md"), mutate)).rejects.toThrow(/current vault/);
    await expect(manager.processFrontMatter(file("Deleted.md"), mutate)).rejects.toThrow(/does not exist/);
    await expect(manager.processFrontMatter(files.get("image.png")!, mutate)).rejects.toThrow(/Markdown/);
    expect(mutate).not.toHaveBeenCalled();
    expect(vault.read).not.toHaveBeenCalled();
    expect(vault.modify).not.toHaveBeenCalled();
  });

  it("revalidates ownership after reading and before callback mutation", async () => {
    const { app, files, vault } = fakeApp({ "Note.md": "Body\n" });
    const manager = new FileManager(app);
    const note = files.get("Note.md")!;
    let release!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    vault.read.mockImplementationOnce(async () => {
      markStarted();
      await blocked;
      return "Body\n";
    });

    const firstMutation = vi.fn((fm: Record<string, unknown>) => { fm.first = true; });
    const secondMutation = vi.fn((fm: Record<string, unknown>) => { fm.second = true; });
    const first = manager.processFrontMatter(note, firstMutation);
    const second = manager.processFrontMatter(note, secondMutation);
    await started;
    files.delete("Note.md");
    const firstRejected = expect(first).rejects.toThrow(/does not exist/);
    const secondRejected = expect(second).rejects.toThrow(/does not exist/);
    release();

    await firstRejected;
    await secondRejected;
    expect(firstMutation).not.toHaveBeenCalled();
    expect(secondMutation).not.toHaveBeenCalled();
    expect(vault.modify).not.toHaveBeenCalled();
  });

  it("makes callback and serialization failures zero-write", async () => {
    const { app, files, vault, contents } = fakeApp({ "Note.md": "Body\n" });
    const manager = new FileManager(app);
    const note = files.get("Note.md")!;

    await expect(manager.processFrontMatter(note, () => {
      throw new Error("stop");
    })).rejects.toThrow("stop");
    await expect(manager.processFrontMatter(note, (fm) => {
      fm.unsupported = Symbol("cannot serialize");
    })).rejects.toThrow();
    await expect(manager.processFrontMatter(note, (fm) => {
      fm.recoveredAfterSerialization = true;
    })).resolves.toBeUndefined();
    expect(vault.modify).toHaveBeenCalledTimes(1);
    expect(readFrontmatter(contents.get("Note.md")!)).toMatchObject({ recoveredAfterSerialization: true });
  });
});
