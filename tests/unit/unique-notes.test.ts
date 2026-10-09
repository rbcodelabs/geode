import { describe, expect, it } from "vitest";
import moment from "moment";
import { UniqueNotesService, resolveUniqueNotesConfig, uniqueNotePath } from "../../src/renderer/unique-notes";
import type { ConfigService } from "../../src/renderer/host/contracts";

const now = moment("2024-01-01T09:45:30");
const defaults = { folder: "", format: "YYYYMMDDHHmm", template: "" };

describe("resolveUniqueNotesConfig", () => {
  it("applies Obsidian defaults when unset", () => {
    expect(resolveUniqueNotesConfig(null)).toEqual({ enabled: true, ...defaults });
  });
  it("validates per field and trims folder slashes", () => {
    expect(resolveUniqueNotesConfig({ enabled: false, folder: " /Zettel/ ", format: 5, template: " Templates/Z " }))
      .toEqual({ enabled: false, folder: "Zettel", format: "YYYYMMDDHHmm", template: "Templates/Z" });
  });
});

describe("uniqueNotePath", () => {
  it("uses the default time-coded name at the vault root", () => {
    expect(uniqueNotePath(now, defaults, () => false)).toMatchObject({ path: "202401010945.md", name: "202401010945" });
  });
  it("honours folder and a custom Daily-notes-style format", () => {
    const settings = { folder: "Zettel", format: "YYYY-MM-DD HHmm", template: "" };
    expect(uniqueNotePath(now, settings, () => false).path).toBe("Zettel/2024-01-01 0945.md");
  });
  it("advances to the next available timestamp on collision", () => {
    const taken = new Set(["202401010945.md", "202401010946.md"]);
    const result = uniqueNotePath(now, defaults, p => taken.has(p));
    expect(result.path).toBe("202401010947.md");
    expect(result.time.format("HH:mm")).toBe("09:47");
  });
  it("gives up with a clear error when every candidate is taken", () => {
    expect(() => uniqueNotePath(now, { ...defaults, format: "YYYY" }, () => true)).toThrow(/unused unique note name/);
  });
});

describe("UniqueNotesService", () => {
  function memoryConfig(initial?: unknown) {
    const store = new Map<string, unknown>(initial ? [["unique-notes", initial]] : []);
    const config = {
      read: async (name: string) => store.get(name) ?? null,
      write: async (name: string, value: unknown) => { store.set(name, value); },
    } as unknown as ConfigService;
    return { config, store };
  }
  it("loads persisted options and persists updates", async () => {
    const { config, store } = memoryConfig({ folder: "Z", format: "YYYYMMDD" });
    const service = new UniqueNotesService(config);
    await service.load();
    expect(service.options).toEqual({ folder: "Z", format: "YYYYMMDD", template: "" });
    await service.update({ template: "T/x", enabled: false });
    expect(service.enabled).toBe(false);
    expect(store.get("unique-notes")).toEqual({ enabled: false, folder: "Z", format: "YYYYMMDD", template: "T/x" });
  });
  it("keeps previous settings when persistence fails", async () => {
    const service = new UniqueNotesService({ read: async () => null, write: async () => { throw new Error("nope"); } } as unknown as ConfigService);
    await service.load();
    await expect(service.update({ folder: "A" })).rejects.toThrow("nope");
    expect(service.options.folder).toBe("");
  });
});
