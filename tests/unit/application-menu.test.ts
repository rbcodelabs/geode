import { describe, expect, it, vi } from "vitest";
import { buildApplicationMenuTemplate } from "../../src/main/application-menu";

type Item = Electron.MenuItemConstructorOptions;

const PLATFORMS: NodeJS.Platform[] = ["darwin", "win32", "linux"];

function template(platform: NodeJS.Platform): Item[] {
  return buildApplicationMenuTemplate(platform, () => {});
}

/** Every item in the template, depth-first, including nested submenus. */
function walk(items: Item[]): Item[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? walk(item.submenu as Item[]) : []),
  ]);
}

// Electron accepts several spellings of the same modifier, and the stock
// `fileMenu` role happens to use "CommandOrControl+W", the longest of them.
// Matching only "CmdOrCtrl" would let the regression back in unnoticed.
const isCloseWindowAccelerator = (accelerator: string | undefined) =>
  /^(cmdorctrl|commandorcontrol|command|cmd|ctrl|control|super|meta)\+w$/i.test(accelerator ?? "");

/**
 * Electron expands these roles into submenus that carry a `CmdOrCtrl+W`
 * accelerator we never see in the template, so the "nothing binds Cmd+W"
 * assertion below has to reject the roles themselves, not just explicit
 * accelerator strings.
 *
 * - `fileMenu` → `{ role: "close" }` on darwin.
 * - `windowMenu` → `{ role: "close" }` on every platform except darwin.
 * - a bare `{ role: "close" }` → Close Window on `CmdOrCtrl+W`.
 */
function rolesImplyingCloseWindowShortcut(platform: NodeJS.Platform, item: Item): boolean {
  if (item.role === "fileMenu") return true;
  if (item.role === "windowMenu") return platform !== "darwin";
  if (item.role === "close") return item.accelerator === undefined;
  return false;
}

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

  // Regression: Cmd+W is Geode's "close-tab" command. Any menu item bound to
  // the same accelerator shadows it whenever the key is not consumed by the
  // renderer, which is exactly what happens in a <webview> tab, and closes the
  // whole window instead of the tab.
  describe.each(PLATFORMS)("on %s", (platform) => {
    it("binds no menu item to CmdOrCtrl+W, explicitly or via a role", () => {
      const offenders = walk(template(platform)).filter(
        (item) =>
          isCloseWindowAccelerator(item.accelerator as string | undefined) ||
          rolesImplyingCloseWindowShortcut(platform, item),
      );
      expect(offenders).toEqual([]);
    });

    it("puts Close Window on CmdOrCtrl+Shift+W", () => {
      const closeItems = walk(template(platform)).filter((item) => item.role === "close");
      expect(closeItems).toHaveLength(1);
      expect(closeItems[0].accelerator).toBe("CmdOrCtrl+Shift+W");
    });

    it("keeps a File menu", () => {
      const file = template(platform).find(
        (item) => item.label === "File" || item.role === "fileMenu",
      );
      expect(file).toBeDefined();
      expect(Array.isArray(file?.submenu)).toBe(true);
      expect((file?.submenu as Item[]).length).toBeGreaterThan(0);
    });

    it("keeps a Window menu with Minimize and Zoom", () => {
      const window = template(platform).find(
        (item) => item.label === "Window" || item.role === "windowMenu",
      );
      expect(window).toBeDefined();
      // darwin keeps the stock role (its expansion has no Close Window item);
      // elsewhere the submenu is spelled out so Close can be re-accelerated.
      if (platform === "darwin") {
        expect(window?.role).toBe("windowMenu");
      } else {
        const roles = (window?.submenu as Item[]).map((item) => item.role);
        expect(roles).toContain("minimize");
        expect(roles).toContain("zoom");
      }
    });
  });

  it("keeps Quit in the File menu on Windows and Linux, matching the stock expansion", () => {
    for (const platform of ["win32", "linux"] as NodeJS.Platform[]) {
      const file = template(platform).find((item) => item.label === "File");
      expect((file?.submenu as Item[]).map((item) => item.role)).toContain("quit");
    }
  });
});
