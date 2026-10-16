import { describe, expect, it } from "vitest";
const api = await import("../../src/renderer/excluded-files").catch(() => ({})) as typeof import("../../src/renderer/excluded-files");
describe("excluded potential-link targets", () => {
  it("matches exact files and folder boundaries with normalized separators", () => {
    expect(api.compileExcludedFiles).toBeTypeOf("function");
    const matches = api.compileExcludedFiles(["Private\\Notes/", "Archive.md"]);
    expect(matches("Private/Notes/A.md")).toBe(true);
    expect(matches("Private/NotesOld/A.md")).toBe(false);
    expect(matches("Archive.md")).toBe(true);
    expect(matches("Some/Archive.md")).toBe(false);
  });
  it("supports bounded safe regex patterns and rejects unsafe or malformed patterns", () => {
    expect(api.compileExcludedFiles(["/^archive\\//i"])("Archive/One.md")).toBe(true);
    for (const expression of ["/(a+)+$/", "/a.*b.*/", "/(foo|bar)/", "/[bad/", "/foo\\1/", "../Private", "/" + "a".repeat(129) + "/"]) {
      expect(() => api.compileExcludedFiles([expression]), expression).toThrow();
    }
  });
});

it("retains last saved exclusions on invalid input or failed persistence and scopes by vault", async () => {
  const storage = new Map<string, unknown>();
  let failWrite = false;
  const state = { read: async <T>(key: string) => (storage.get(key) ?? null) as T | null,
    write: async (key: string, value: unknown) => { if (failWrite) throw new Error("disk full"); storage.set(key, value); }, remove: async () => {} };
  const first = new api.ExcludedFiles(state, "vault-one"); await first.ready;
  await first.save(["Private"]);
  await expect(first.save(["/(nested+)+/"])).rejects.toThrow();
  expect(first.matches("Private/Note.md")).toBe(true);
  failWrite = true; await expect(first.save(["Other"])).rejects.toThrow("disk full");
  expect(first.patterns).toEqual(["Private"]);
  const same = new api.ExcludedFiles(state, "vault-one"); await same.ready; expect(same.matches("Private/Note.md")).toBe(true);
  const another = new api.ExcludedFiles(state, "vault-two"); await another.ready; expect(another.matches("Private/Note.md")).toBe(false);
});
