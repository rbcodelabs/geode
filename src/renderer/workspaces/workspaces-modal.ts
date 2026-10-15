import type { App } from "../app";
import { Modal } from "../modals/modals";
import { NamedWorkspaces, type NamedLayout } from "./named-workspaces";

interface Actions {
  capture(): unknown;
  load(layout: NamedLayout): Promise<string>;
  run<T>(operation: () => Promise<T>): Promise<T>;
}
/** The manager preserves input and records when configuration writes fail. */
export class WorkspacesModal extends Modal {
  private readonly nameInput = document.createElement("input");
  private readonly save = document.createElement("button");
  private readonly rows = document.createElement("div");
  private readonly status = document.createElement("div");
  private closed = false;
  private busy = false;
  private ready = false;
  constructor(app: App, private readonly store: NamedWorkspaces, private readonly actions: Actions) {
    super(app);
    this.titleEl.textContent = "Manage workspace layouts";
    this.modalEl.classList.add("workspaces-modal");
    const label = document.createElement("label"); label.textContent = "Name"; label.htmlFor = "workspace-layout-name";
    this.nameInput.id = "workspace-layout-name"; this.nameInput.setAttribute("aria-label", "Name"); this.nameInput.maxLength = 120;
    this.save.type = "button"; this.save.textContent = "Save"; this.save.disabled = true;
    const form = document.createElement("div"); form.className = "workspaces-save-row"; form.append(this.nameInput, this.save);
    const hint = document.createElement("p"); hint.className = "setting-item-description"; hint.textContent = "Saving with the same name updates that layout.";
    this.status.className = "workspaces-status"; this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    this.contentEl.append(label, form, hint, this.rows, this.status);
    const save = () => void this.perform(async () => {
      const record = await this.store.save(this.nameInput.value, this.actions.capture()); return `Saved ${record.name}.`;
    });
    this.save.addEventListener("click", save);
    this.nameInput.addEventListener("keydown", event => { if (event.key === "Enter" && !this.save.disabled) { event.preventDefault(); save(); } });
  }
  onOpen(): void { void this.refresh().then(() => { if (!this.closed) this.nameInput.focus(); }); }
  onClose(): void { this.closed = true; }
  private setBusy(busy: boolean): void {
    this.busy = busy; this.save.disabled = busy || !this.ready; this.nameInput.disabled = busy;
    for (const button of this.rows.querySelectorAll("button")) button.disabled = busy || !this.ready;
    this.contentEl.setAttribute("aria-busy", String(busy));
  }
  private async refresh(): Promise<void> {
    try {
      const records = await this.store.list(); if (this.closed) return;
      this.ready = true; this.rows.replaceChildren();
      if (!records.length) this.rows.textContent = "No saved workspace layouts.";
      for (const record of records) {
        const row = document.createElement("div"); row.className = "workspaces-saved-row";
        const name = document.createElement("span"); name.className = "workspaces-saved-name"; name.textContent = record.name;
        const load = document.createElement("button"); load.type = "button"; load.textContent = "Load"; load.setAttribute("aria-label", `Load ${record.name}`);
        load.addEventListener("click", () => void this.perform(async () => this.actions.load(await this.store.get(record.id))));
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Delete layout"; remove.setAttribute("aria-label", `Delete ${record.name} layout`);
        remove.addEventListener("click", () => void this.perform(async () => { await this.store.remove(record.id); return `Deleted ${record.name} layout.`; }));
        row.append(name, load, remove); this.rows.append(row);
      }
      this.setBusy(this.busy);
    } catch (error) { if (!this.closed) { this.ready = false; this.setBusy(false); this.show(error, true); } }
  }
  private show(value: unknown, error: boolean): void {
    this.status.textContent = value instanceof Error ? value.message : String(value);
    this.status.setAttribute("role", error ? "alert" : "status"); this.status.classList.toggle("is-error", error);
  }
  private async perform(operation: () => Promise<string>): Promise<void> {
    if (this.closed || this.busy || !this.ready) return;
    this.setBusy(true);
    try { const message = await this.actions.run(operation); if (!this.closed) { await this.refresh(); if (this.ready) this.show(message, false); } }
    catch (error) { if (!this.closed) this.show(error, true); }
    finally { if (!this.closed) this.setBusy(false); }
  }
}
