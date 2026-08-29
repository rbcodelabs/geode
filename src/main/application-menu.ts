import type { BaseWindow, MenuItemConstructorOptions } from "electron";

/**
 * Close Window's accelerator. Cmd+W belongs to Geode's "close-tab" command,
 * so nothing at the menu layer may claim it: a menu accelerator wins whenever
 * a keystroke bubbles back unhandled from the renderer, which is exactly what
 * happens inside a `<webview>` tab.
 */
const CLOSE_WINDOW_ACCELERATOR = "CmdOrCtrl+Shift+W";

/**
 * Reload the whole renderer. Electron hands the click the window the menu was
 * invoked from; it is never captured up front because crash recovery replaces
 * the window (main.ts recoverRenderer) and there can be several windows open.
 */
export type ReloadAppHandler = (window: BaseWindow | undefined) => void;

export function buildApplicationMenuTemplate(
  platform: NodeJS.Platform,
  onExportDiagnostics: () => void | Promise<void>,
  onReloadApp: ReloadAppHandler,
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
    {
      // Spelled out rather than `{ role: "viewMenu" }`, whose expansion binds
      // Reload to CmdOrCtrl+R and Force Reload to Shift+CmdOrCtrl+R. Cmd+R is
      // Geode's "web.reload" action (reload the page in a web/artifact tab)
      // and Cmd+Shift+R is "toggle-right-sidebar", so both stock accelerators
      // shadowed real commands and reloading the renderer from a web tab
      // destroyed every open pane and unsaved buffer.
      label: "View",
      submenu: [
        {
          // Deliberately no `role` and no `accelerator`. A `role: "reload"`
          // would silently reintroduce its default CmdOrCtrl+R key equivalent.
          // The label states the cost because nothing warns before the wipe.
          label: "Reload app (discards unsaved state)",
          click: (_menuItem, window) => onReloadApp(window),
        },
        { type: "separator" },
        // Force Reload is gone entirely: its Shift+CmdOrCtrl+R collided with
        // Geode's toggle-right-sidebar and it adds nothing over Reload app.
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
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
