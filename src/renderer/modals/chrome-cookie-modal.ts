import type { App } from "../app";
import { Modal } from "./modals";

/**
 * "Import cookies from Chrome" profile picker (Web Viewer settings). Manual,
 * one-time, user-initiated only — see src/main/chrome-cookies.ts for the
 * decrypt/inject implementation this drives via the `listChromeProfiles`/
 * `importChromeCookies` IPC bridge (preload.ts).
 */
export class ChromeCookieImportModal extends Modal {
  private listEl!: HTMLElement;
  private statusEl!: HTMLElement;

  constructor(app: App) {
    super(app);
    this.modalEl.classList.add("mod-chrome-cookie-import");
  }

  onOpen(): void {
    const heading = document.createElement("h2");
    heading.textContent = "Import cookies from Chrome";
    this.contentEl.appendChild(heading);

    const warning = document.createElement("p");
    warning.className = "community-trust-warning";
    warning.textContent =
      "This copies live session cookies from the selected Chrome profile into Geode's Web Viewer session, so tabs open already logged in. One-time, explicit action — cookies are not kept in sync afterward.";
    this.contentEl.appendChild(warning);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "community-status";
    this.contentEl.appendChild(this.statusEl);

    this.listEl = document.createElement("div");
    this.listEl.className = "community-list";
    this.contentEl.appendChild(this.listEl);

    void this.loadProfiles();
  }

  private async loadProfiles(): Promise<void> {
    this.statusEl.textContent = "Looking for Chrome profiles…";
    let profiles: { dir: string; name: string }[];
    try {
      profiles = await window.geode.listChromeProfiles();
    } catch (err) {
      this.statusEl.textContent = `Couldn't list Chrome profiles: ${(err as Error).message}`;
      return;
    }
    this.statusEl.textContent = "";
    this.listEl.innerHTML = "";
    if (!profiles.length) {
      const empty = document.createElement("div");
      empty.className = "community-empty";
      empty.textContent = "No Chrome profiles found.";
      this.listEl.appendChild(empty);
      return;
    }
    for (const profile of profiles) {
      const row = document.createElement("div");
      row.className = "community-item";
      const info = document.createElement("div");
      info.className = "community-item-info";
      info.innerHTML = `<div class="community-item-title">${profile.name}</div><div class="community-item-sub">${profile.dir}</div>`;
      row.appendChild(info);

      const btn = document.createElement("button");
      btn.className = "mod-cta";
      btn.textContent = "Import";
      btn.addEventListener("click", () => void this.importProfile(profile, btn));
      row.appendChild(btn);

      this.listEl.appendChild(row);
    }
  }

  private async importProfile(profile: { dir: string; name: string }, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    this.statusEl.textContent = `Importing cookies from ${profile.name}…`;
    try {
      const result = await window.geode.importChromeCookies(profile.dir);
      this.app.notify(`Imported ${result.imported} cookie(s) from ${profile.name}${result.skipped ? ` (${result.skipped} skipped)` : ""}`);
      this.close();
    } catch (err) {
      this.statusEl.textContent = `Import failed: ${(err as Error).message}`;
      btn.disabled = false;
    }
  }
}
