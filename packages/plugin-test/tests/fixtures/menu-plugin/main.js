const { Plugin, ItemView, Menu } = require("obsidian");
class V extends ItemView {
  getViewType() { return "menu-plugin:view"; }
  getDisplayText() { return "Menu view"; }
  async onOpen() {
    const b = this.contentEl.createEl("button", { text: "open menu", cls: "mp-btn" });
    b.style.cssText = "position:fixed;right:4px;bottom:4px";
    const pill = this.contentEl.createEl("span", { text: "Connected", cls: "mp-pill" });
    pill.style.cssText = "display:inline-block;margin:40px 0 0 40px;padding:2px 8px";
    pill.addEventListener("click", () => {
      const r = pill.getBoundingClientRect();
      const m = new Menu();
      m.addItem((i) => i.setTitle("Restart session"));
      m.addItem((i) => i.setTitle("Reconnect"));
      m.showAtPosition({ x: r.left, y: r.bottom });
    });
    b.addEventListener("click", (e) => {
      const m = new Menu();
      m.addItem((i) => i.setTitle("First").setIcon("check"));
      m.addItem((i) => i.setTitle("Second"));
      m.showAtMouseEvent(e);
    });
  }
}
module.exports = class extends Plugin { onload() { this.registerView("menu-plugin:view", (l) => new V(l)); } };
