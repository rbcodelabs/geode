import type { MenuItemConstructorOptions } from "electron";

/**
 * Close Window's accelerator. Cmd+W belongs to Geode's "close-tab" command,
 * so nothing at the menu layer may claim it: a menu accelerator wins whenever
 * a keystroke bubbles back unhandled from the renderer, which is exactly what
 * happens inside a `<webview>` tab.
 */
const CLOSE_WINDOW_ACCELERATOR = "CmdOrCtrl+Shift+W";

export function buildApplicationMenuTemplate(
  platform: NodeJS.Platform,
  onExportDiagnostics: () => void | Promise<void>,
): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  return [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      // Spelled out rather than `{ role: "fileMenu" }`, whose darwin expansion
      // is a bare `{ role: "close" }` on CmdOrCtrl+W.
      label: "File",
      submenu: isMac
        ? [{ role: "close" as const, accelerator: CLOSE_WINDOW_ACCELERATOR }]
        : [{ role: "quit" as const }],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    isMac
      // The darwin expansion of `windowMenu` is Minimize / Zoom / Front, with
      // no Close Window item, so the stock role is safe here.
      ? { role: "windowMenu" as const }
      : {
          // Everywhere else `windowMenu` expands to Minimize / Zoom / Close,
          // and that Close would reintroduce the CmdOrCtrl+W binding.
          label: "Window",
          submenu: [
            { role: "minimize" as const },
            { role: "zoom" as const },
            { type: "separator" as const },
            { role: "close" as const, accelerator: CLOSE_WINDOW_ACCELERATOR },
          ],
        },
    {
      role: "help",
      submenu: [{ label: "Export Diagnostics…", click: () => { void onExportDiagnostics(); } }],
    },
  ];
}
