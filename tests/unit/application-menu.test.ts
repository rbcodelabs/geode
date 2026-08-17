import { describe, expect, it, vi } from "vitest";
import { buildApplicationMenuTemplate } from "../../src/main/application-menu";

describe("application menu", () => {
  it("installs Help -> Export Diagnostics and delegates its click", async () => {
    const exportDiagnostics = vi.fn(async () => {});
    const template = buildApplicationMenuTemplate("darwin", exportDiagnostics);
    const help = template.find((item) => item.role === "help");
    expect(help).toBeDefined();
    expect(Array.isArray(help?.submenu)).toBe(true);
    const exportItem = (help?.submenu as Electron.MenuItemConstructorOptions[]).find(
      (item) => item.label === "Export Diagnostics…",
    );
    expect(exportItem).toBeDefined();

    await (exportItem?.click as () => Promise<void>)();
    expect(exportDiagnostics).toHaveBeenCalledOnce();
  });
});
