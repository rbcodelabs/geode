import { describe, expect, it, vi } from "vitest";
import {
  buildNewFileContents,
  createFileForView,
  resolveNewFilePath,
  type CreateFileForViewVault,
} from "../../src/renderer/views/bases/create-file-for-view";
import type { TFile, TFolder } from "../../src/renderer/types";

/**
 * `BasesView.createFileForView` — the Bases quick-add write path.
 *
 * The behaviour that matters most here is what happens when the request cannot
 * be honoured exactly. Every rejection below names a case where a note *could*
 * still have been written to the vault root; doing that would scatter a user's
 * notes outside the folder their view is configured for, and the board would
 * show a card that silently lives somewhere else.
 */
function fakeVault(existingFolders: string[], existingFiles: string[] = []) {
  const folders = new Set(existingFolders);
  const files = new Set(existingFiles);
  const created: { path: string; data: string }[] = [];
  const vault: CreateFileForViewVault = {
    getFolderByPath: (path) => (folders.has(path) ? ({ path } as TFolder) : null),
    availablePath: (folder, base, ext) => {
      const prefix = folder ? `${folder}/` : "";
      let candidate = `${prefix}${base}.${ext}`;
      let n = 1;
      while (files.has(candidate)) candidate = `${prefix}${base} ${n++}.${ext}`;
      return candidate;
    },
    create: vi.fn(async (path: string, data: string) => {
      created.push({ path, data });
      files.add(path);
      return { path } as TFile;
    }),
  };
  return { vault, created };
}

describe("resolveNewFilePath", () => {
  it("places the note in the folder the view asked for", () => {
    const { vault } = fakeVault(["Board"]);
    expect(resolveNewFilePath(vault, "kanban-view", "Board/New card")).toBe("Board/New card.md");
  });

  it("accepts a name that already carries the .md extension", () => {
    const { vault } = fakeVault(["Board"]);
    expect(resolveNewFilePath(vault, "kanban-view", "Board/New card.md")).toBe("Board/New card.md");
  });

  it("creates at the vault root only when no folder was requested", () => {
    const { vault } = fakeVault([]);
    expect(resolveNewFilePath(vault, "kanban-view", "Loose note")).toBe("Loose note.md");
  });

  it("uniquifies instead of overwriting an existing note", () => {
    const { vault } = fakeVault(["Board"], ["Board/New card.md", "Board/New card 1.md"]);
    expect(resolveNewFilePath(vault, "kanban-view", "Board/New card")).toBe("Board/New card 2.md");
  });

  it("throws when no name is supplied, rather than inventing 'Untitled'", () => {
    const { vault } = fakeVault(["Board"]);
    expect(() => resolveNewFilePath(vault, "kanban-view", undefined)).toThrow(/without a file name/);
    expect(() => resolveNewFilePath(vault, "kanban-view", "   ")).toThrow(/without a file name/);
  });

  it("throws when the configured folder does not exist, rather than falling back to the root", () => {
    const { vault } = fakeVault(["Board"]);
    expect(() => resolveNewFilePath(vault, "kanban-view", "Missing/New card")).toThrow(
      /the folder "Missing" does not exist/
    );
  });

  it("refuses a path that climbs out of the vault", () => {
    const { vault } = fakeVault(["Board"]);
    expect(() => resolveNewFilePath(vault, "kanban-view", "Board/../../escape")).toThrow(
      /does not resolve to a path inside the vault/
    );
  });
});

describe("buildNewFileContents", () => {
  it("writes only the keys the processor set", () => {
    const contents = buildNewFileContents((fm) => {
      fm.status = "Doing";
      fm.owner = "Rick";
    });
    expect(contents).toBe("---\nstatus: Doing\nowner: Rick\n---\n");
  });

  it("produces an empty note when the processor sets nothing", () => {
    expect(buildNewFileContents((fm) => delete fm.status)).toBe("");
    expect(buildNewFileContents()).toBe("");
  });

  it("rejects an async processor instead of writing a note missing its properties", () => {
    expect(() => buildNewFileContents((async () => {}) as unknown as (fm: any) => void)).toThrow(
      /synchronous callback/
    );
  });
});

describe("createFileForView", () => {
  it("writes the note and its frontmatter in a single create", async () => {
    const { vault, created } = fakeVault(["Board"]);

    const file = await createFileForView(vault, "kanban-view", "Board/Ship it", (fm) => {
      fm.status = "To Do";
    });

    expect(file.path).toBe("Board/Ship it.md");
    expect(created).toEqual([{ path: "Board/Ship it.md", data: "---\nstatus: To Do\n---\n" }]);
    // One write: no window in which a note exists without its column value.
    expect(vault.create).toHaveBeenCalledTimes(1);
  });

  it("does not touch the vault when the request is rejected", async () => {
    const { vault } = fakeVault(["Board"]);

    await expect(createFileForView(vault, "kanban-view", "Nope/Card", () => {})).rejects.toThrow(
      /does not exist/
    );
    expect(vault.create).not.toHaveBeenCalled();
  });
});
