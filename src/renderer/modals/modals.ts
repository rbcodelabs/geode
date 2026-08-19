import type { App } from "../app";

export class Modal {
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  contentEl: HTMLElement;
  private keyHandler: (e: KeyboardEvent) => void;

  constructor(protected app: App) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "modal-container";
    this.modalEl = document.createElement("div");
    this.modalEl.className = "modal";
    this.contentEl = document.createElement("div");
    this.contentEl.className = "modal-content";
    this.modalEl.appendChild(this.contentEl);
    this.containerEl.appendChild(this.modalEl);
    this.containerEl.addEventListener("mousedown", (e) => {
      if (e.target === this.containerEl) this.close();
    });
    this.keyHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    };
  }

  open() {
    document.body.appendChild(this.containerEl);
    document.addEventListener("keydown", this.keyHandler, true);
    this.onOpen();
  }

  close() {
    document.removeEventListener("keydown", this.keyHandler, true);
    this.containerEl.remove();
    this.onClose();
  }

  onOpen(): void {}
  onClose(): void {}
}

export interface FuzzyMatch<T> {
  item: T;
  score: number;
}

/** Simple subsequence fuzzy scorer: contiguous + word-start bonuses. */
export function fuzzyMatch(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const exact = t.indexOf(q);
  if (exact !== -1) return 1000 - exact - (t.length - q.length) * 0.1;
  let qi = 0;
  let score = 0;
  let lastMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti === lastMatch + 1 ? 8 : 1;
      if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "/" || t[ti - 1] === "-") score += 6;
      lastMatch = ti;
      qi++;
    }
  }
  return qi === q.length ? score - t.length * 0.05 : null;
}

/** A single-line text prompt: Enter calls `onSubmit`, Escape cancels. */
export class PromptModal extends Modal {
  inputEl: HTMLInputElement;

  constructor(
    app: App,
    private opts: { placeholder?: string; initialValue?: string; allowEmptySubmit?: boolean; onSubmit: (value: string) => void }
  ) {
    super(app);
    this.modalEl.classList.add("prompt");
    this.inputEl = document.createElement("input");
    this.inputEl.className = "prompt-input";
    this.inputEl.type = "text";
    this.inputEl.placeholder = opts.placeholder ?? "";
    this.inputEl.value = opts.initialValue ?? "";
    this.contentEl.appendChild(this.inputEl);
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const value = this.inputEl.value.trim();
        this.close();
        if (value || this.opts.allowEmptySubmit) this.opts.onSubmit(value);
      }
    });
  }

  onOpen(): void {
    this.inputEl.focus();
  }
}

export abstract class SuggestModal<T> extends Modal {
  inputEl: HTMLInputElement;
  resultsEl: HTMLElement;
  private items: T[] = [];
  private selected = 0;
  emptyStateText = "No results found.";

  constructor(app: App) {
    super(app);
    this.modalEl.classList.add("prompt");
    this.inputEl = document.createElement("input");
    this.inputEl.className = "prompt-input";
    this.inputEl.type = "text";
    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "prompt-results";
    this.contentEl.appendChild(this.inputEl);
    this.contentEl.appendChild(this.resultsEl);
    this.inputEl.addEventListener("input", () => this.updateResults());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.moveSelection(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.moveSelection(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = this.items[this.selected];
        if (item !== undefined) {
          this.close();
          this.onChooseItem(item, e);
        } else {
          this.onNoMatch(this.inputEl.value, e);
        }
      }
    });
  }

  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: KeyboardEvent | MouseEvent): void;
  /** Called on Enter with no matching item (e.g. create new note). */
  onNoMatch(_query: string, _evt: KeyboardEvent): void {}
  renderItem(item: T, el: HTMLElement): void {
    el.textContent = this.getItemText(item);
  }

  onOpen(): void {
    this.inputEl.focus();
    this.updateResults();
  }

  private moveSelection(delta: number) {
    if (!this.items.length) return;
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    this.renderList();
  }

  protected updateResults() {
    const query = this.inputEl.value;
    const scored: FuzzyMatch<T>[] = [];
    for (const item of this.getItems()) {
      const score = fuzzyMatch(query, this.getItemText(item));
      if (score !== null) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    this.items = scored.slice(0, 80).map((s) => s.item);
    this.selected = 0;
    this.renderList();
  }

  private renderList() {
    this.resultsEl.innerHTML = "";
    if (!this.items.length) {
      const empty = document.createElement("div");
      empty.className = "prompt-empty";
      empty.textContent = this.emptyStateText;
      this.resultsEl.appendChild(empty);
      return;
    }
    this.items.forEach((item, i) => {
      const el = document.createElement("div");
      el.className = "prompt-result" + (i === this.selected ? " is-selected" : "");
      this.renderItem(item, el);
      el.addEventListener("mousemove", () => {
        if (this.selected !== i) {
          this.selected = i;
          this.renderList();
        }
      });
      el.addEventListener("click", (e) => {
        this.close();
        this.onChooseItem(item, e);
      });
      this.resultsEl.appendChild(el);
      if (i === this.selected) el.scrollIntoView({ block: "nearest" });
    });
  }
}
