const obsidian = require("obsidian");

/**
 * Manual counterpart to tests/e2e/file-editor-menu-events.spec.ts.
 *
 * The spec proves the `file-menu` / `editor-menu` events fire with the right
 * arguments; this plugin exists so a human can right-click in a real window
 * and see a plugin-contributed item render after the built-ins. It uses only
 * the documented Obsidian surface (`registerEvent` + `workspace.on`, and the
 * `setTitle`/`setIcon`/`onClick` menu-item builder), so it doubles as a check
 * that the compatibility layer exposes them the way plugin authors expect.
 */
module.exports.default = class extends obsidian.Plugin {
  async onload() {
    // Fires for both files and folders in the File Explorer. Obsidian passes a
    // TAbstractFile here, so branch on the concrete type rather than assuming
    // a file — a folder right-click lands in this same handler.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, source) => {
        const isFolder = file instanceof obsidian.TFolder;
        menu.addItem((item) =>
          item
            .setTitle(isFolder ? `Probe: folder "${file.name}"` : `Probe: file "${file.name}"`)
            .setIcon(isFolder ? "folder" : "file")
            .onClick(() => {
              new obsidian.Notice(`menu-probe — file-menu\npath: ${file.path}\nsource: ${source}`);
            })
        );
      })
    );

    // Fires on every editor right-click, including where no built-in item
    // applies, so this item should always be present in the editor menu.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, _editor, info) => {
        const file = info && info.file;
        menu.addItem((item) =>
          item
            .setTitle("Probe: editor menu")
            .setIcon("star")
            .onClick(() => {
              new obsidian.Notice(`menu-probe — editor-menu\nfile: ${file ? file.path : "(none)"}`);
            })
        );
      })
    );
  }
};
