import type { App } from "../app";
import { Modal } from "./modals";

/** Internal renderer primitive. Callers supply safe, user-facing data, never raw errors. */
export interface ErrorDetailsData {
  title: string;
  cause: string;
  guidance: string;
  preservation: string;
  warning?: string;
  rows: ReadonlyArray<{ label: string; value: string }>;
  report: string;
}

export class ErrorDetailsModal extends Modal {
  private static nextId = 0;
  private readonly returnFocus: HTMLElement | null;
  private readonly closeButton: HTMLButtonElement;
  private readonly containFocus = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const targets = Array.from(this.modalEl.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'));
    const first = targets[0];
    const last = targets[targets.length - 1];
    if (event.shiftKey && (document.activeElement === first || !this.modalEl.contains(document.activeElement))) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !this.modalEl.contains(document.activeElement))) {
      event.preventDefault(); first?.focus();
    }
  };

  constructor(app: App, data: ErrorDetailsData, private readonly closed: () => void) {
    super(app);
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.modalEl.classList.add("error-details-modal");
    this.modalEl.setAttribute("role", "dialog");
    this.modalEl.setAttribute("aria-modal", "true");
    this.modalEl.setAttribute("aria-label", data.title);
    this.titleEl.textContent = data.title;
    const dismiss = document.createElement("button");
    dismiss.className = "modal-close-button";
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Close details");
    dismiss.addEventListener("click", () => this.close());
    this.titleEl.after(dismiss);
    this.contentEl.tabIndex = 0;
    this.contentEl.setAttribute("aria-label", "Error details");
    const paragraph = (text: string, className: string) => {
      const el = document.createElement("p"); el.className = className; el.textContent = text;
      this.contentEl.append(el); return el;
    };
    const cause = paragraph(data.cause, "error-details-cause");
    cause.id = `error-details-cause-${++ErrorDetailsModal.nextId}`;
    this.modalEl.setAttribute("aria-describedby", cause.id);
    paragraph(data.guidance, "error-details-guidance");
    paragraph(data.preservation, "error-details-preservation");
    if (data.warning) paragraph(data.warning, "error-details-warning");
    const heading = document.createElement("h3"); heading.textContent = "Technical details";
    const rows = document.createElement("dl");
    for (const row of data.rows) {
      const label = document.createElement("dt"); label.textContent = row.label;
      const value = document.createElement("dd"); value.textContent = row.value;
      rows.append(label, value);
    }
    this.contentEl.append(heading, rows);
    paragraph("Copied diagnostics omit file paths and note contents.", "error-details-privacy");
    const feedback = document.createElement("p"); feedback.className = "error-details-feedback"; feedback.setAttribute("role", "status");
    this.contentEl.append(feedback);
    const footer = document.createElement("div"); footer.className = "error-details-footer";
    const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "Copy diagnostics";
    copy.addEventListener("click", () => {
      void (async () => {
        try { await navigator.clipboard.writeText(data.report); feedback.textContent = "Copied (paths redacted)."; }
        catch { feedback.textContent = "Could not copy. Copy the operation and error code above manually."; }
      })();
    });
    this.closeButton = document.createElement("button"); this.closeButton.type = "button";
    this.closeButton.className = "mod-cta"; this.closeButton.textContent = "Close";
    this.closeButton.addEventListener("click", () => this.close());
    footer.append(copy, this.closeButton); this.modalEl.append(footer);
  }

  onOpen(): void {
    document.addEventListener("keydown", this.containFocus, true);
    this.closeButton.focus();
  }

  onClose(): void {
    document.removeEventListener("keydown", this.containFocus, true);
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
    this.closed();
  }
}
