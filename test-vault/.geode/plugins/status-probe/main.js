const obsidian = require("obsidian");

module.exports.default = class extends obsidian.Plugin {
  async onload() {
    const status = this.addStatusBarItem();
    status.addClass("probe-status");
    status.classList.add("mod-clickable");
    status.setAttribute("aria-label", "Status bar probe");
    const icon = status.createSpan({ cls: "status-bar-item-icon" });
    obsidian.setIcon(icon, "check");
    const label = status.createSpan({ cls: "probe-status-text" });
    label.setText("probe: idle");
    status.addEventListener("click", () => label.setText("probe: clicked"));
  }
};
