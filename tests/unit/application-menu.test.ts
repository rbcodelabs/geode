import { describe, expect, it, vi } from "vitest";
import { buildApplicationMenuTemplate } from "../../src/main/application-menu";

type Item = Electron.MenuItemConstructorOptions;

const PLATFORMS: NodeJS.Platform[] = ["darwin", "win32", "linux"];

function template(platform: NodeJS.Platform): Item[] {
  return buildApplicationMenuTemplate(platform, () => {}, () => {});
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

// The View menu's stock role carries the other two accelerators Geode needs:
// CmdOrCtrl+R (Geode's web.reload action) and Shift+CmdOrCtrl+R (Geode's
// toggle-right-sidebar). Neither appears as an explicit accelerator string in
// the template, so the roles themselves have to be rejected.
//
// - `viewMenu` → `{ role: "reload" }` + `{ role: "forceReload" }`.
// - a bare `{ role: "reload" }` → CmdOrCtrl+R.
// - a bare `{ role: "forceReload" }` → Shift+CmdOrCtrl+R.
const rolesImplyingReloadShortcut = (item: Item): boolean =>
  item.role === "viewMenu" || item.role === "reload" || item.role === "forceReload";

const isReloadAccelerator = (accelerator: string | undefined) =>
  /^(cmdorctrl|commandorcontrol|command|cmd|ctrl|control|super|meta)\+(shift\+)?r$/i.test(accelerator ?? "");

const viewMenu = (platform: NodeJS.Platform): Item | undefined =>
  template(platform).find((item) => item.label === "View" || item.role === "viewMenu");

describe("application menu", () => {
  it("installs Help -> Export Diagnostics and delegates its click", async () => {
    const exportDiagnostics = vi.fn(async () => {});
    const template = buildApplicationMenuTemplate("darwin", exportDiagnostics, () => {});
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

    // Regression: Cmd+R inside a <webview> tab used to reach the stock View
    // menu's Reload and wipe the whole renderer — every open pane and every
    // unsaved buffer — instead of reloading the page.
    it("binds no menu item to CmdOrCtrl+R, explicitly or via a role", () => {
      const offenders = walk(template(platform)).filter(
        (item) =>
          isReloadAccelerator(item.accelerator as string | undefined) ||
          rolesImplyingReloadShortcut(item),
      );
      expect(offenders).toEqual([]);
    });

    it("keeps the safe View roles the hand-rolled submenu replaced", () => {
      const roles = (viewMenu(platform)?.submenu as Item[]).map((item) => item.role);
      for (const role of ["toggleDevTools", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]) {
        expect(roles).toContain(role);
      }
    });

    it("offers Reload app with neither a role nor an accelerator", () => {
      const reloadApp = (viewMenu(platform)?.submenu as Item[]).find((item) =>
        typeof item.label === "string" && item.label.startsWith("Reload app"),
      );
      expect(reloadApp).toBeDefined();
      // A role would reintroduce the accelerator through the back door.
      expect(reloadApp?.role).toBeUndefined();
      expect(reloadApp?.accelerator).toBeUndefined();
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

  it("delegates Reload app to the injected handler with the clicked window", () => {
    const reloadApp = vi.fn();
    const built = buildApplicationMenuTemplate("darwin", () => {}, reloadApp);
    const view = built.find((item) => item.label === "View");
    const reloadItem = (view?.submenu as Item[]).find(
      (item) => typeof item.label === "string" && item.label.startsWith("Reload app"),
    );
    const clickedWindow = { id: 7 } as unknown as Electron.BaseWindow;
    (reloadItem?.click as NonNullable<Item["click"]>)(
      undefined as unknown as Electron.MenuItem,
      clickedWindow,
      undefined as unknown as Electron.KeyboardEvent,
    );
    // The window is passed through rather than captured at build time: crash
    // recovery replaces windows, so a captured one could already be dead.
    expect(reloadApp).toHaveBeenCalledOnce();
    expect(reloadApp).toHaveBeenCalledWith(clickedWindow);
  });

  it("keeps Quit in the File menu on Windows and Linux, matching the stock expansion", () => {
    for (const platform of ["win32", "linux"] as NodeJS.Platform[]) {
      const file = template(platform).find((item) => item.label === "File");
      expect((file?.submenu as Item[]).map((item) => item.role)).toContain("quit");
    }
  });
});
