import { describe, expect, it } from "vitest";
import { extractSection, parseEmbedDims, resolveEmbed } from "../../src/renderer/markdown/embed";
import { MetadataCache } from "../../src/renderer/metadata-cache";
import { FakeVault } from "../helpers/fake-vault";

async function buildApp(files: Record<string, string>) {
  const fake = new FakeVault(files);
  const metadataCache = new MetadataCache(fake.asVault());
  await metadataCache.initialize();
  // resolveEmbed only touches app.metadataCache, so a minimal stand-in
  // (cast to App) is enough — same pattern as FakeVault.asVault().
  return { app: { metadataCache } as unknown as import("../../src/renderer/app").App, fake };
}

describe("resolveEmbed", () => {
  it("classifies an image target", async () => {
    const { app } = await buildApp({ "pic.png": "" });
    const resolved = resolveEmbed("pic.png", "Welcome.md", app);
    expect(resolved.kind).toBe("image");
    expect(resolved.file?.path).toBe("pic.png");
    expect(resolved.subpath).toBe("");
  });

  it("classifies an audio target", async () => {
    const { app } = await buildApp({ "song.mp3": "" });
    expect(resolveEmbed("song.mp3", "Welcome.md", app).kind).toBe("audio");
  });

  it("classifies a video target", async () => {
    const { app } = await buildApp({ "clip.mp4": "" });
    expect(resolveEmbed("clip.mp4", "Welcome.md", app).kind).toBe("video");
  });

  it("classifies a .md target as a note and captures a #Heading subpath", async () => {
    const { app } = await buildApp({ "Projects/Roadmap.md": "" });
    const resolved = resolveEmbed("Projects/Roadmap#Q3", "Welcome.md", app);
    expect(resolved.kind).toBe("note");
    expect(resolved.file?.path).toBe("Projects/Roadmap.md");
    expect(resolved.subpath).toBe("#Q3");
  });

  it("classifies an unresolved target with no matching file", async () => {
    const { app } = await buildApp({});
    const resolved = resolveEmbed("Nope", "Welcome.md", app);
    expect(resolved.kind).toBe("unresolved");
    expect(resolved.file).toBeNull();
  });

  it("classifies a resolved file with an unrecognized extension as 'other'", async () => {
    const { app } = await buildApp({ "notes.pdf": "" });
    expect(resolveEmbed("notes.pdf", "Welcome.md", app).kind).toBe("other");
  });
});

describe("parseEmbedDims", () => {
  it("parses width-only", () => {
    expect(parseEmbedDims("100")).toEqual({ width: "100", height: undefined });
  });

  it("parses width and height", () => {
    expect(parseEmbedDims("100x50")).toEqual({ width: "100", height: "50" });
  });

  it("returns an empty object for a non-dimension param", () => {
    expect(parseEmbedDims("")).toEqual({});
    expect(parseEmbedDims("caption text")).toEqual({});
  });
});

describe("extractSection", () => {
  const text = "# Title\n\n## Q3\nShip the editor.\n\n## Q4\nPlugin API.\n";

  it("extracts a heading's body up to the next heading of <= level", () => {
    expect(extractSection(text, "Q3")).toBe("## Q3\nShip the editor.\n");
  });

  it("extracts to end of document when the heading is the last one", () => {
    expect(extractSection(text, "Q4")).toBe("## Q4\nPlugin API.\n");
  });

  it("returns the full text unchanged when the heading isn't found", () => {
    expect(extractSection(text, "Nonexistent")).toBe(text);
  });

  it("is case-insensitive when matching the heading", () => {
    expect(extractSection(text, "q3")).toBe("## Q3\nShip the editor.\n");
  });
});
