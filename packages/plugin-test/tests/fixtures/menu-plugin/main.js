const { Plugin, ItemView, Menu } = require("obsidian");
class V extends ItemView {
  getViewType() { return "menu-plugin:view"; }
  getDisplayText() { return "Menu view"; }
  async onOpen() {
    const b = this.contentEl.createEl("button", { text: "open menu", cls: "mp-btn" });
    b.style.cssText = "position:fixed;right:4px;bottom:4px";
    b.addEventListener("click", (e) => {
      const m = new Menu();
      m.addItem((i) => i.setTitle("First").setIcon("check"));
      m.addItem((i) => i.setTitle("Second"));
      m.showAtMouseEvent(e);
    });
  }
}
module.exports = class extends Plugin { onload() { this.registerView("menu-plugin:view", (l) => new V(l)); } };
