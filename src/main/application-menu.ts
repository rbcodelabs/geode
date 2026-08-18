import type { MenuItemConstructorOptions } from "electron";

export function buildApplicationMenuTemplate(
  platform: NodeJS.Platform,
  onExportDiagnostics: () => void | Promise<void>,
): MenuItemConstructorOptions[] {
  return [
    ...(platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Export Diagnostics…", click: () => { void onExportDiagnostics(); } }],
    },
  ];
}
