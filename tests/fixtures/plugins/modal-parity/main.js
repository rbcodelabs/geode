const { Plugin, Modal } = require("obsidian");

/**
 * Opens a modal through the public plugin API (`api/obsidian.ts`'s Modal),
 * which is the class that renders Obsidian's full modal tree: `.modal-bg`,
 * `.modal-title`, `.modal-close-button` and a `.modal-button-container`.
 * Those four selectors are exactly what the parity spec measures.
 *
 * Plain DOM calls throughout — deliberately not Obsidian's `createEl`/`createDiv`
 * helpers, so the fixture exercises the modal chrome rather than the DOM shim.
 */
module.exports.default = class ModalParityProbe extends Plugin {
  onload() {
    const plugin = this;
    window.__modalParityProbe = {
      /** @param {{ emptyTitle?: boolean }} [opts] */
      open(opts) {
        const modal = new Modal(plugin.app);
        if (!(opts && opts.emptyTitle)) modal.setTitle("Parity probe");

        const body = document.createElement("p");
        body.className = "parity-probe-body";
        body.textContent = "Body copy";
        modal.contentEl.appendChild(body);

        const buttons = document.createElement("div");
        buttons.className = "modal-button-container";
        const cancel = document.createElement("button");
        cancel.textContent = "Cancel";
        const save = document.createElement("button");
        save.className = "mod-cta";
        save.textContent = "Save";
        buttons.append(cancel, save);
        modal.contentEl.appendChild(buttons);

        modal.open();
        window.__modalParityProbe.last = modal;
        return true;
      },
    };
  }
};
