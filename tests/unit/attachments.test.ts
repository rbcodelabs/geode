import { describe, expect, it } from "vitest";
import {
  attachmentFileName,
  extensionForMime,
  imageFilesFromDrop,
  imageFilesFromPaste,
  pastedImageName,
  resolveAttachmentFolder,
  saveImageAttachments,
  uniqueAttachmentPath,
  type AttachmentSource,
  type AttachmentVault,
  type TransferLike,
} from "../../src/renderer/attachments";

function source(name: string, type: string, bytes = [1, 2, 3]): AttachmentSource {
  return { name, type, arrayBuffer: async () => new Uint8Array(bytes).buffer };
}

/** In-memory vault recording every write, tracking folder children the way `Vault` does. */
class FakeAttachmentVault implements AttachmentVault {
  readonly written = new Map<string, number>();
  readonly folders = new Set<string>([""]);
  readonly createdFolders: string[] = [];
  constructor(private config: Record<string, unknown> = {}, existing: string[] = []) {
    for (const path of existing) this.remember(path);
  }
  private remember(path: string) {
    this.written.set(path, (this.written.get(path) ?? 0) + 1);
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
  }
  getConfig(key: string) { return this.config[key]; }
  getFolderByPath(path: string) {
    const folder = path === "/" ? "" : path;
    if (!this.folders.has(folder)) return null;
    const prefix = folder ? `${folder}/` : "";
    const children = [...this.written.keys()]
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map((p) => ({ name: p.slice(prefix.length) }));
    return { children };
  }
  async createFolder(path: string) {
    this.createdFolders.push(path);
    this.folders.add(path);
  }
  async createBinary(path: string, data: ArrayBuffer) {
    if (this.written.has(path)) throw new Error(`File already exists: ${path}`);
    this.remember(path);
    return { path, name: path.split("/").pop()!, size: data.byteLength } as never;
  }
}

describe("extensionForMime", () => {
  it("maps common clipboard image types", () => {
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/svg+xml")).toBe("svg");
    expect(extensionForMime("image/webp")).toBe("webp");
  });
  it("returns null for non-images and unknown image subtypes", () => {
    expect(extensionForMime("text/plain")).toBeNull();
    expect(extensionForMime("image/x-weird")).toBeNull();
    expect(extensionForMime("")).toBeNull();
  });
});

describe("pastedImageName", () => {
  it("uses Obsidian's local-time 'Pasted image YYYYMMDDHHmmss' pattern", () => {
    expect(pastedImageName("png", new Date(2026, 8, 28, 8, 30, 55))).toBe("Pasted image 20260928083055.png");
    expect(pastedImageName("jpg", new Date(2026, 0, 2, 3, 4, 5))).toBe("Pasted image 20260102030405.jpg");
  });
});

describe("attachmentFileName", () => {
  const now = new Date(2026, 8, 28, 8, 30, 55);
  it("names a pasted screenshot with the generic clipboard name", () => {
    expect(attachmentFileName(source("image.png", "image/png"), "paste", now)).toBe("Pasted image 20260928083055.png");
    expect(attachmentFileName(source("", "image/jpeg"), "paste", now)).toBe("Pasted image 20260928083055.jpg");
  });
  it("keeps the real name of a pasted or dropped file", () => {
    expect(attachmentFileName(source("Diagram v2.png", "image/png"), "paste", now)).toBe("Diagram v2.png");
    expect(attachmentFileName(source("image.png", "image/png"), "drop", now)).toBe("image.png");
  });
  it("replaces characters that would break a wikilink or a path", () => {
    expect(attachmentFileName(source("a#b^c[d]e|f/g.png", "image/png"), "drop", now)).toBe("a-b-c-d-e-f-g.png");
  });
  it("derives the extension from the MIME type when the name has none", () => {
    expect(attachmentFileName(source("photo", "image/webp"), "drop", now)).toBe("photo.webp");
  });
  it("rejects files that are not images", () => {
    expect(attachmentFileName(source("notes.pdf", "application/pdf"), "drop", now)).toBeNull();
    expect(attachmentFileName(source("readme.txt", ""), "drop", now)).toBeNull();
  });
  it("accepts an image by extension when the OS reports no MIME type", () => {
    expect(attachmentFileName(source("scan.JPEG", ""), "drop", now)).toBe("scan.JPEG");
  });
});

describe("resolveAttachmentFolder", () => {
  it("defaults to the vault root, like Obsidian", () => {
    expect(resolveAttachmentFolder(undefined, "Notes/a.md")).toBe("");
    expect(resolveAttachmentFolder("", "Notes/a.md")).toBe("");
    expect(resolveAttachmentFolder("/", "Notes/a.md")).toBe("");
  });
  it("supports Obsidian's same-folder and subfolder forms", () => {
    expect(resolveAttachmentFolder("./", "Notes/a.md")).toBe("Notes");
    expect(resolveAttachmentFolder("./assets", "Notes/a.md")).toBe("Notes/assets");
    expect(resolveAttachmentFolder("./assets", "a.md")).toBe("assets");
  });
  it("supports a fixed vault-relative folder", () => {
    expect(resolveAttachmentFolder("Attachments/", "Notes/a.md")).toBe("Attachments");
    expect(resolveAttachmentFolder("/Attachments/img", "Notes/a.md")).toBe("Attachments/img");
  });
  it("falls back to the root for non-string or escaping values", () => {
    expect(resolveAttachmentFolder(42, "a.md")).toBe("");
    expect(resolveAttachmentFolder("../outside", "Notes/a.md")).toBe("");
    expect(resolveAttachmentFolder("a/../../b", "a.md")).toBe("");
  });
});

describe("uniqueAttachmentPath", () => {
  it("returns the plain path when nothing collides", () => {
    expect(uniqueAttachmentPath("", "pic.png", [])).toBe("pic.png");
    expect(uniqueAttachmentPath("assets", "pic.png", ["other.png"])).toBe("assets/pic.png");
  });
  it("appends an incrementing number, Obsidian style", () => {
    expect(uniqueAttachmentPath("", "pic.png", ["pic.png"])).toBe("pic 1.png");
    expect(uniqueAttachmentPath("", "pic.png", ["pic.png", "pic 1.png"])).toBe("pic 2.png");
  });
  it("treats names case-insensitively (macOS/Windows filesystems)", () => {
    expect(uniqueAttachmentPath("", "Pic.PNG", ["pic.png"])).toBe("Pic 1.PNG");
  });
});

describe("saveImageAttachments", () => {
  const now = new Date(2026, 8, 28, 8, 30, 55);

  it("saves a pasted image at the vault root with a Pasted image name", async () => {
    const vault = new FakeAttachmentVault();
    const saved = await saveImageAttachments(vault, [source("image.png", "image/png")], { sourcePath: "Notes/a.md", origin: "paste", now });
    expect(saved.map((f) => f.path)).toEqual(["Pasted image 20260928083055.png"]);
    expect(vault.written.has("Pasted image 20260928083055.png")).toBe(true);
  });

  it("never overwrites: a second paste in the same second gets a numeric suffix", async () => {
    const vault = new FakeAttachmentVault();
    const opts = { sourcePath: "a.md", origin: "paste" as const, now };
    await saveImageAttachments(vault, [source("image.png", "image/png")], opts);
    const again = await saveImageAttachments(vault, [source("image.png", "image/png")], opts);
    expect(again[0].path).toBe("Pasted image 20260928083055 1.png");
  });

  it("de-duplicates several dropped files with the same name in one batch", async () => {
    const vault = new FakeAttachmentVault({}, ["cat.png"]);
    const saved = await saveImageAttachments(
      vault,
      [source("cat.png", "image/png"), source("cat.png", "image/png")],
      { sourcePath: "a.md", origin: "drop", now },
    );
    expect(saved.map((f) => f.path)).toEqual(["cat 1.png", "cat 2.png"]);
  });

  it("honours attachmentFolderPath and creates a missing folder first", async () => {
    const vault = new FakeAttachmentVault({ attachmentFolderPath: "./assets" });
    const saved = await saveImageAttachments(vault, [source("cat.png", "image/png")], { sourcePath: "Notes/a.md", origin: "drop", now });
    expect(vault.createdFolders).toEqual(["Notes/assets"]);
    expect(saved[0].path).toBe("Notes/assets/cat.png");
  });

  it("skips files that are not images and reports nothing saved for them", async () => {
    const vault = new FakeAttachmentVault();
    const saved = await saveImageAttachments(vault, [source("a.pdf", "application/pdf")], { sourcePath: "a.md", origin: "drop", now });
    expect(saved).toEqual([]);
    expect(vault.written.size).toBe(0);
  });

  it("rejects when the vault write fails, leaving no partial success hidden", async () => {
    const vault = new FakeAttachmentVault();
    vault.createBinary = async () => { throw new Error("disk full"); };
    await expect(
      saveImageAttachments(vault, [source("cat.png", "image/png")], { sourcePath: "a.md", origin: "drop", now }),
    ).rejects.toThrow("disk full");
  });
});

function transfer(files: AttachmentSource[], text = ""): TransferLike {
  return { files, getData: (type: string) => (type === "text/plain" ? text : "") };
}

describe("imageFilesFromPaste", () => {
  it("returns the image files of an image-only clipboard", () => {
    const png = source("image.png", "image/png");
    expect(imageFilesFromPaste(transfer([png]))).toEqual([png]);
  });
  it("leaves mixed text-and-image clipboards to the default paste (e.g. spreadsheet cells)", () => {
    expect(imageFilesFromPaste(transfer([source("image.png", "image/png")], "A1\tB1"))).toEqual([]);
  });
  it("ignores clipboards with no image files", () => {
    expect(imageFilesFromPaste(transfer([source("a.pdf", "application/pdf")]))).toEqual([]);
    expect(imageFilesFromPaste(transfer([]))).toEqual([]);
    expect(imageFilesFromPaste(null)).toEqual([]);
  });
});

describe("imageFilesFromDrop", () => {
  it("returns only the image files of a drop", () => {
    const png = source("a.png", "image/png");
    expect(imageFilesFromDrop(transfer([png, source("a.pdf", "application/pdf")]))).toEqual([png]);
  });
  it("returns nothing for a drop without files (text, in-app drags)", () => {
    expect(imageFilesFromDrop(transfer([]))).toEqual([]);
    expect(imageFilesFromDrop(null)).toEqual([]);
  });
});
