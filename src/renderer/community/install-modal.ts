/**
 * "Install from GitHub" modal (Phase 1;
 * docs/adr/0001-community-install-from-github.md). Enter an `owner/repo`,
 * optionally Check to preview the resolved item, then Install. A trust warning
 * is always shown; enabling an installed plugin (which runs its code) is a
 * separate opt-in checkbox, off by default.
 */

import type { App } from "../app";
import { Modal } from "../modals/modals";
import type { CommunityManager } from "./community-manager";
import type { ItemType } from "../../main/github-resolve";

export class InstallFromGithubModal extends Modal {
  private repoInput!: HTMLInputElement;
  private typeSelect!: HTMLSelectElement;
  private enableCheckbox!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private installBtn!: HTMLButtonElement;
  private busy = false;

  constructor(
    app: App,
    private community: CommunityManager,
    private onInstalled?: () => void
  ) {
    super(app);
    this.modalEl.classList.add("mod-community-install");
  }

  onOpen(): void {
    const heading = document.createElement("h2");
    heading.textContent = "Install from GitHub";
    this.contentEl.appendChild(heading);

    this.repoInput = document.createElement("input");
    this.repoInput.type = "text";
    this.repoInput.className = "community-repo-input";
    this.repoInput.placeholder = "owner/repo";
    this.contentEl.appendChild(this.repoInput);

    this.typeSelect = document.createElement("select");
    this.typeSelect.className = "dropdown community-type-select";
    for (const [value, label] of [
      ["auto", "Auto-detect"],
      ["plugin", "Plugin"],
      ["theme", "Theme"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      this.typeSelect.appendChild(opt);
    }
    this.contentEl.appendChild(this.typeSelect);

    const warning = document.createElement("p");
    warning.className = "community-trust-warning";
    warning.textContent =
      "Plugins run with full access to your files and system. Only install from authors you trust.";
    this.contentEl.appendChild(warning);

    const enableRow = document.createElement("label");
    enableRow.className = "community-enable-row";
    this.enableCheckbox = document.createElement("input");
    this.enableCheckbox.type = "checkbox";
    this.enableCheckbox.className = "community-enable-checkbox";
    enableRow.appendChild(this.enableCheckbox);
    // A plugin gets enabled; a theme gets applied. The label covers both since
    // the type can be auto-detected only at install time.
    enableRow.appendChild(document.createTextNode(" Enable / apply after installing"));
    this.contentEl.appendChild(enableRow);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "community-status";
    this.contentEl.appendChild(this.statusEl);

    const buttons = document.createElement("div");
    buttons.className = "community-buttons";
    const checkBtn = document.createElement("button");
    checkBtn.className = "community-check-btn";
    checkBtn.textContent = "Check";
    checkBtn.addEventListener("click", () => void this.check());
    this.installBtn = document.createElement("button");
    this.installBtn.className = "community-install-btn mod-cta";
    this.installBtn.textContent = "Install";
    this.installBtn.addEventListener("click", () => void this.install());
    buttons.appendChild(checkBtn);
    buttons.appendChild(this.installBtn);
    this.contentEl.appendChild(buttons);

    this.repoInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.install();
    });
    this.repoInput.focus();
  }

  private resolveOpts() {
    const t = this.typeSelect.value as "auto" | ItemType;
    return { type: t === "auto" ? undefined : t };
  }

  private setStatus(text: string, isError = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("is-error", isError);
  }

  private async check(): Promise<void> {
    const spec = this.repoInput.value.trim();
    if (!spec || this.busy) return;
    this.busy = true;
    this.setStatus("Resolving…");
    try {
      const preview = await this.community.resolve(spec, this.resolveOpts());
      this.setStatus(
        `${preview.name} — ${preview.type} ${preview.version} (${preview.source} ${preview.ref})`
      );
    } catch (err) {
      this.setStatus((err as Error).message, true);
    } finally {
      this.busy = false;
    }
  }

  private async install(): Promise<void> {
    const spec = this.repoInput.value.trim();
    if (!spec || this.busy) return;
    this.busy = true;
    this.installBtn.disabled = true;
    this.setStatus("Installing…");
    try {
      const installed = await this.community.install(spec, this.resolveOpts());
      if (this.enableCheckbox.checked && installed.type === "plugin") {
        await this.app.pluginManager.enable(installed.id);
        this.app.notify(`Enabled ${installed.name} ${installed.version}`);
      } else if (this.enableCheckbox.checked && installed.type === "theme") {
        await this.app.applyCommunityTheme(installed.id);
        this.app.notify(`Applied ${installed.name} ${installed.version}`);
      } else {
        this.app.notify(`Installed ${installed.name} ${installed.version}`);
      }
      this.onInstalled?.();
      this.close();
    } catch (err) {
      this.setStatus((err as Error).message, true);
      this.busy = false;
      this.installBtn.disabled = false;
    }
  }
}
