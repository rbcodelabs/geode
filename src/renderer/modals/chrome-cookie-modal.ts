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

    // Electron keeps cookies with no expiry in memory only and never writes
    // them to disk, so session-scoped logins (Gmail's GMAIL_AT and
    // __Host-GMAIL_SCH among them) are gone after a restart. Stated up front
    // rather than letting the user discover it as a silent logout.
    const restartNote = document.createElement("p");
    restartNote.className = "community-trust-warning";
    restartNote.textContent =
      "Cookies Chrome holds only for the current browsing session cannot be saved to disk, so they are lost when Geode restarts. Sites that rely on them will need another import after a restart.";
    this.contentEl.appendChild(restartNote);

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
      const notes = [
        result.skipped ? `${result.skipped} skipped` : "",
        // Concrete count, so "you may need to re-import" is an observation
        // about this profile rather than boilerplate.
        result.sessionScoped
          ? `${result.sessionScoped} session-only, lost on restart`
          : "",
      ].filter(Boolean);
      this.app.notify(
        `Imported ${result.imported} cookie(s) from ${profile.name}${notes.length ? ` (${notes.join("; ")})` : ""}`,
      );
      this.close();
    } catch (err) {
      this.statusEl.textContent = `Import failed: ${(err as Error).message}`;
      btn.disabled = false;
    }
  }
}
