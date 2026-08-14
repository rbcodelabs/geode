import { describe, expect, it } from "vitest";
import { patchFrontmatter, patchFrontmatterText } from "../../src/renderer/frontmatter-io";
import type { TFile } from "../../src/renderer/types";
import type { VaultWriter } from "../../src/renderer/frontmatter-io";

function file(path: string): TFile {
  return { kind: "file", path, name: path, basename: path, extension: "md", mtime: 0, ctime: 0, size: 0, parent: "" };
}

describe("patchFrontmatterText (pure)", () => {
  it("adds a new property to existing frontmatter", () => {
    const text = "---\nstatus: draft\n---\nBody text\n";
    const result = patchFrontmatterText(text, (fm) => {
      fm.status = "done";
    });
    expect(result).toContain("status: done");
    expect(result).toContain("Body text");
    expect(result.startsWith("---\n")).toBe(true);
  });

  it("creates a frontmatter block when the file has none", () => {
    const text = "Just body text, no frontmatter.\n";
    const result = patchFrontmatterText(text, (fm) => {
      fm.tag = "new";
    });
    expect(result).toBe('---\ntag: new\n---\nJust body text, no frontmatter.\n');
  });

  it("leaves a file with no frontmatter and no mutation unchanged", () => {
    const text = "Just body text.\n";
    const result = patchFrontmatterText(text, () => {});
    expect(result).toBe(text);
  });

  it("removes the frontmatter block entirely when the last property is deleted", () => {
    const text = "---\nonly: prop\n---\nBody\n";
    const result = patchFrontmatterText(text, (fm) => {
      delete fm.only;
    });
    expect(result).toBe("Body\n");
  });

  it("round-trips existing properties untouched when mutate only adds a new one", () => {
    const text = "---\na: 1\nb: two\n---\nBody\n";
    const result = patchFrontmatterText(text, (fm) => {
      fm.c = true;
    });
    expect(result).toContain("a: 1");
    expect(result).toContain("b: two");
    expect(result).toContain("c: true");
  });

  it("treats malformed existing frontmatter YAML as an empty object to mutate from", () => {
    const text = "---\n: not valid: yaml: at all\n---\nBody\n";
    const result = patchFrontmatterText(text, (fm) => {
      fm.status = "ok";
    });
    expect(result).toContain("status: ok");
  });

  it("preserves CRLF line endings in the closing delimiter match", () => {
    const text = "---\r\nstatus: draft\r\n---\r\nBody\r\n";
    const result = patchFrontmatterText(text, (fm) => {
      fm.status = "done";
    });
    expect(result).toContain("status: done");
  });
});

describe("patchFrontmatter (I/O wrapper)", () => {
  it("reads, mutates, and writes back only when the text actually changed", async () => {
    let written: string | null = null;
    const vault: VaultWriter = {
      read: async () => "---\nstatus: draft\n---\nBody\n",
      modify: async (_f, data) => {
        written = data;
      },
    };
    await patchFrontmatter(vault, file("A.md"), (fm) => {
      fm.status = "done";
    });
    expect(written).toContain("status: done");
  });

  it("does not call modify() when the mutation is a no-op", async () => {
    let modifyCalled = false;
    const vault: VaultWriter = {
      read: async () => "---\nstatus: draft\n---\nBody\n",
      modify: async () => {
        modifyCalled = true;
      },
    };
    await patchFrontmatter(vault, file("A.md"), () => {});
    expect(modifyCalled).toBe(false);
  });
});
