import { inspectProperties, isEditablePropertyValue, parsePropertyNumber, type PropertyMutation, type PropertyScalar, type PropertyValue } from "./property-source";

export interface PropertyEditorOptions {
  getText(): string;
  editable(): boolean;
  commit(operation: PropertyMutation): { ok: true } | { ok: false; error: string };
  openSource(): void;
}
interface FocusToken { key?: string; field?: string; index?: string; start: number | null; end: number | null }

/** Shared control surface; all serialization and file ownership belong to adapters. */
export class PropertyEditor {
  readonly root = document.createElement("div");
  private dirty = false;
  private error = "";
  constructor(private readonly options: PropertyEditorOptions) {
    this.root.className = "metadata-properties";
    this.refresh();
  }
  private focusToken(): FocusToken | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement) || !this.root.contains(active)) return null;
    return { key: active.dataset.propertyKey, field: active.dataset.propertyField, index: active.dataset.propertyIndex, start: active.selectionStart, end: active.selectionEnd };
  }
  private restoreFocus(token: FocusToken | null): void {
    if (!token) return;
    queueMicrotask(() => {
      if (!this.root.isConnected || (document.activeElement !== document.body && !this.root.contains(document.activeElement))) return;
      const input = [...this.root.querySelectorAll<HTMLInputElement>("input")].find(input => input.dataset.propertyKey === token.key && input.dataset.propertyField === token.field && input.dataset.propertyIndex === token.index);
      input?.focus({ preventScroll: true });
      if (input && token.start !== null && input.type !== "checkbox") input.setSelectionRange(token.start, token.end);
    });
  }
  refresh(force = false, focus = this.focusToken()): void {
    if (!force && this.dirty && this.root.contains(document.activeElement)) return;
    const inspection = inspectProperties(this.options.getText());
    const inner = document.createElement("div"); inner.className = "metadata-properties-inner";
    const heading = document.createElement("div"); heading.className = "metadata-properties-heading"; heading.textContent = "Properties";
    inner.append(heading);
    if (!inspection.ok) {
      inner.append(this.message(inspection.error), this.sourceButton());
    } else {
      const editable = this.options.editable();
      if (!editable) { const message = document.createElement("div"); message.className = "pane-empty"; message.textContent = "This note is read-only."; inner.append(message); }
      for (const [key, value] of Object.entries(inspection.values)) inner.append(this.row(key, value, editable));
      if (this.error) inner.append(this.message(this.error));
      const add = document.createElement("button"); add.type = "button"; add.className = "metadata-add-button"; add.textContent = "+ Add property"; add.setAttribute("aria-label", "Add property"); add.disabled = !editable;
      add.addEventListener("click", () => { add.replaceWith(this.newRow()); });
      inner.append(add);
    }
    this.root.replaceChildren(inner);
    this.restoreFocus(focus);
  }
  private message(text: string): HTMLElement {
    const error = document.createElement("div"); error.className = "metadata-property-error"; error.setAttribute("role", "alert"); error.textContent = text;
    return error;
  }
  private sourceButton(): HTMLButtonElement {
    const button = document.createElement("button"); button.type = "button"; button.textContent = "Edit source"; button.addEventListener("click", () => this.options.openSource()); return button;
  }
  private apply(operation: PropertyMutation, input?: HTMLInputElement): boolean {
    if (!this.options.editable()) { this.showError("This note is read-only.", input); return false; }
    const result = this.options.commit(operation);
    if (!result.ok) { this.showError(result.error, input); return false; }
    this.dirty = false; this.error = "";
    let focus = this.focusToken();
    if (focus && operation.kind === "rename") focus = { ...focus, key: operation.name.trim() };
    this.refresh(true, focus);
    return true;
  }
  private showError(text: string, input?: HTMLInputElement): void {
    this.error = text; this.dirty = true; input?.setAttribute("aria-invalid", "true");
    this.root.querySelector(".metadata-property-error")?.remove();
    this.root.append(this.message(text));
  }
  private wireInput(input: HTMLInputElement, commit: () => void): void {
    input.addEventListener("input", () => { this.dirty = true; input.removeAttribute("aria-invalid"); });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); commit(); }
      if (event.key === "Escape") { event.preventDefault(); this.dirty = false; this.error = ""; this.refresh(true); }
    });
    input.addEventListener("blur", () => { if (this.dirty) commit(); });
  }
  private identity(input: HTMLInputElement, key: string, field: string, index?: number): void {
    input.dataset.propertyKey = key; input.dataset.propertyField = field;
    if (index !== undefined) input.dataset.propertyIndex = String(index);
  }
  private row(key: string, value: unknown, editable: boolean): HTMLElement {
    const row = document.createElement("div"); row.className = "metadata-property";
    const supported = isEditablePropertyValue(value);
    const keyCell = document.createElement("div"); keyCell.className = "metadata-property-key";
    const icon = document.createElement("span"); icon.className = "metadata-property-icon"; icon.textContent = Array.isArray(value) ? "≡" : typeof value === "boolean" ? "☑" : typeof value === "number" ? "#" : "Aa";
    const name = document.createElement("input"); name.className = "metadata-input metadata-key-input"; name.value = key; name.disabled = !editable || !supported; name.setAttribute("aria-label", `Property name: ${key}`); this.identity(name, key, "name");
    this.wireInput(name, () => { if (name.value.trim() !== key) this.apply({ kind: "rename", key, name: name.value, expected: value }, name); else { this.dirty = false; this.error = ""; this.refresh(true); } });
    keyCell.append(icon, name);
    const valueCell = document.createElement("div"); valueCell.className = "metadata-property-value";
    if (!supported) { const warning = document.createElement("span"); warning.textContent = "Nested value — edit source"; valueCell.append(warning, this.sourceButton()); }
    else if (Array.isArray(value)) this.list(valueCell, key, value, editable);
    else valueCell.append(this.valueInput(key, value, editable, next => this.apply({ kind: "set", key, value: next, expected: value })));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "metadata-property-remove"; remove.textContent = "×"; remove.setAttribute("aria-label", `Remove property: ${key}`); remove.disabled = !editable || !supported; remove.addEventListener("click", () => this.apply({ kind: "remove", key, expected: value }));
    row.append(keyCell, valueCell, remove); return row;
  }
  private valueInput(key: string, value: PropertyScalar, editable: boolean, commit: (next: PropertyScalar) => boolean, index?: number): HTMLInputElement {
    const input = document.createElement("input"); input.className = "metadata-input"; input.disabled = !editable; input.setAttribute("aria-label", `Value: ${key}${index === undefined ? "" : ` item ${index + 1}`}`); this.identity(input, key, "value", index);
    if (typeof value === "boolean") { input.type = "checkbox"; input.checked = value; input.addEventListener("change", () => commit(input.checked)); }
    else {
      input.value = value === null ? "" : String(value); if (value === null) input.placeholder = "Unset";
      if (typeof value === "number") input.inputMode = "decimal";
      this.wireInput(input, () => {
        let next: PropertyScalar = input.value;
        if (typeof value === "number") { const parsed = parsePropertyNumber(input.value); if (parsed === null) { this.showError("Enter a finite number.", input); return; } next = parsed; }
        else if (value === null && input.value === "") next = null;
        if (next !== value) commit(next); else { this.dirty = false; this.error = ""; this.refresh(true); }
      });
    }
    return input;
  }
  private list(container: HTMLElement, key: string, values: PropertyScalar[], editable: boolean): void {
    container.classList.add("metadata-property-list");
    values.forEach((value, index) => {
      const item = document.createElement("div"); item.className = "metadata-list-item";
      item.append(this.valueInput(key, value, editable, next => this.apply({ kind: "set", key, value: values.map((previous, position) => position === index ? next : previous), expected: values }), index));
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "−"; remove.disabled = !editable; remove.setAttribute("aria-label", `Remove ${key} item ${index + 1}`); remove.addEventListener("click", () => this.apply({ kind: "set", key, value: values.filter((_, position) => position !== index), expected: values }));
      item.append(remove); container.append(item);
    });
    const add = document.createElement("button"); add.type = "button"; add.textContent = "+"; add.disabled = !editable; add.setAttribute("aria-label", `Add ${key} list item`); add.addEventListener("click", () => this.apply({ kind: "set", key, value: [...values, ""], expected: values })); container.append(add);
  }
  private newRow(): HTMLElement {
    const row = document.createElement("div"); row.className = "metadata-property is-new";
    const name = document.createElement("input"); name.className = "metadata-input metadata-key-input"; name.placeholder = "name"; name.setAttribute("aria-label", "New property name");
    const value = document.createElement("input"); value.className = "metadata-input"; value.placeholder = "value"; value.setAttribute("aria-label", "New property value");
    const save = document.createElement("button"); save.type = "button"; save.textContent = "Save property";
    const commit = () => this.apply({ kind: "add", key: name.value, value: value.value === "true" ? true : value.value === "false" ? false : parsePropertyNumber(value.value) ?? value.value }, name);
    name.addEventListener("input", () => { this.dirty = true; }); value.addEventListener("input", () => { this.dirty = true; });
    for (const input of [name, value]) input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); commit(); } });
    save.addEventListener("click", commit); row.append(name, value, save); queueMicrotask(() => name.focus()); return row;
  }
}
