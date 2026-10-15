import { PROPERTY_TYPES, isPropertyTypeValue, type PropertyTypes } from "./property-types";
import { inspectProperties, isEditablePropertyValue, parsePropertyNumber, type PropertyMutation, type PropertyScalar, type PropertyValue } from "./property-source";

export interface PropertyEditorOptions {
  types?: PropertyTypes;
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
  private stopTypes?: () => void;
  private closed = false;
  constructor(private readonly options: PropertyEditorOptions) {
    this.root.className = "metadata-properties";
    this.stopTypes = options.types?.onChange(() => this.refresh());
    this.refresh();
  }
  destroy(): void { this.closed = true; this.stopTypes?.(); }
  private focusToken(): FocusToken | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement) && !(typeof HTMLSelectElement !== "undefined" && active instanceof HTMLSelectElement)) return null;
    if (!this.root.contains(active)) return null;
    return { key: active.dataset.propertyKey, field: active.dataset.propertyField, index: active.dataset.propertyIndex, start: active instanceof HTMLInputElement ? active.selectionStart : null, end: active instanceof HTMLInputElement ? active.selectionEnd : null };
  }
  private restoreFocus(token: FocusToken | null): void {
    if (!token) return;
    queueMicrotask(() => {
      if (!this.root.isConnected || (document.activeElement !== document.body && !this.root.contains(document.activeElement))) return;
      const input = [...this.root.querySelectorAll<HTMLInputElement>("input"), ...this.root.querySelectorAll<HTMLSelectElement>("select")].find(input => input.dataset.propertyKey === token.key && input.dataset.propertyField === token.field && input.dataset.propertyIndex === token.index);
      input?.focus({ preventScroll: true });
      if (input instanceof HTMLInputElement && token.start !== null && ["text", "search", "url", "tel", "password"].includes(input.type)) input.setSelectionRange(token.start, token.end);
    });
  }
  refresh(force = false, focus = this.focusToken()): void {
    if (this.closed) return;
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
    if (this.closed || !this.options.editable()) { this.showError("This note is read-only.", input); return false; }
    if (operation.kind === "set" && this.options.types && !isPropertyTypeValue(this.options.types.getType(operation.key, operation.expected), operation.value)) {
      this.showError("This value does not match the current property type. Choose another type or edit source.", input); return false;
    }
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
  private identity(input: HTMLInputElement | HTMLSelectElement, key: string, field: string, index?: number): void {
    input.dataset.propertyKey = key; input.dataset.propertyField = field;
    if (index !== undefined) input.dataset.propertyIndex = String(index);
  }
  private row(key: string, value: unknown, editable: boolean): HTMLElement {
    const row = document.createElement("div"); row.className = "metadata-property";
    const supported = isEditablePropertyValue(value);
    const type = this.options.types?.getType(key, value) ?? (Array.isArray(value) ? "list" : typeof value === "boolean" ? "checkbox" : typeof value === "number" ? "number" : "text");
    const compatible = supported && isPropertyTypeValue(type, value);
    const keyCell = document.createElement("div"); keyCell.className = "metadata-property-key";
    const icon = document.createElement("select"); icon.className = "metadata-property-icon metadata-property-type";
    icon.setAttribute("aria-label", `Type: ${key}`); icon.title = `Property type: ${type}`;
    const choices = ["tags", "aliases", "cssclasses"].includes(key.toLowerCase()) ? [type] : [...PROPERTY_TYPES];
    if (!choices.includes(type)) choices.unshift(type as typeof PROPERTY_TYPES[number]);
    for (const choice of choices) { const option = document.createElement("option"); option.value = choice; option.textContent = `${({ text: "Aa", list: "≡", tags: "#", number: "#", checkbox: "☑", date: "▦", datetime: "◷" } as Record<string, string>)[choice] ?? "?"} ${choice}`; icon.append(option); }
    this.identity(icon, key, "type");
    icon.value = type; icon.disabled = !editable || !supported || !this.options.types || choices.length === 1;
    icon.addEventListener("change", () => {
      const current = inspectProperties(this.options.getText());
      if (this.closed || !this.options.editable() || !current.ok || !Object.hasOwn(current.values, key) || JSON.stringify(current.values[key]) !== JSON.stringify(value)) { this.showError("This property changed or is read-only. Refresh before changing its type."); return; }
      try { this.options.types?.setType(key, icon.value); }
      catch (error) { this.showError(error instanceof Error ? error.message : "Could not change property type."); }
    });
    const name = document.createElement("input"); name.className = "metadata-input metadata-key-input"; name.value = key; name.disabled = !editable || !supported; name.setAttribute("aria-label", `Property name: ${key}`); this.identity(name, key, "name");
    this.wireInput(name, () => { if (name.value.trim() !== key) this.apply({ kind: "rename", key, name: name.value, expected: value }, name); else { this.dirty = false; this.error = ""; this.refresh(true); } });
    keyCell.append(icon, name);
    const valueCell = document.createElement("div"); valueCell.className = "metadata-property-value";
    if (!supported) { const warning = document.createElement("span"); warning.textContent = "Nested value — edit source"; valueCell.append(warning, this.sourceButton()); }
    else if (!compatible) { const warning = document.createElement("span"); warning.textContent = `This value cannot be edited as ${type}. Choose another type or edit source.`; valueCell.append(warning, this.sourceButton()); }
    else if (type === "list" || type === "tags") this.list(valueCell, key, Array.isArray(value) ? value : value === null ? [] : [value], editable, value);
    else valueCell.append(this.valueInput(key, value as PropertyScalar, editable, next => this.apply({ kind: "set", key, value: next, expected: value }), undefined, type));
    if (compatible && !["list", "tags"].includes(type) && value !== null) {
      const clear = document.createElement("button"); clear.type = "button"; clear.textContent = "Unset"; clear.setAttribute("aria-label", `Unset value: ${key}`); clear.disabled = !editable;
      clear.addEventListener("click", () => this.apply({ kind: "set", key, value: null, expected: value })); valueCell.append(clear);
    }
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "metadata-property-remove"; remove.textContent = "×"; remove.setAttribute("aria-label", `Remove property: ${key}`); remove.disabled = !editable || !supported; remove.addEventListener("click", () => this.apply({ kind: "remove", key, expected: value }));
    row.append(keyCell, valueCell, remove); return row;
  }
  private valueInput(key: string, value: PropertyScalar, editable: boolean, commit: (next: PropertyScalar) => boolean, index?: number, assignedType?: string): HTMLInputElement {
    const input = document.createElement("input"); input.className = "metadata-input"; input.disabled = !editable; input.setAttribute("aria-label", `Value: ${key}${index === undefined ? "" : ` item ${index + 1}`}`); this.identity(input, key, "value", index);
    if (assignedType === "checkbox" || typeof value === "boolean") { input.type = "checkbox"; input.checked = value === true; input.indeterminate = value === null; input.addEventListener("change", () => commit(input.checked)); }
    else {
      if (assignedType === "date" || assignedType === "datetime") { input.type = assignedType === "date" ? "date" : "datetime-local"; input.step = "any"; }
      input.value = value === null ? "" : String(value); if (value === null) input.placeholder = "Unset";
      if (typeof value === "number") input.inputMode = "decimal";
      const initialValue = input.value;
      this.wireInput(input, () => {
        if (input.value === initialValue) { this.dirty = false; this.error = ""; this.refresh(true); return; }
        let next: PropertyScalar = input.value;
        if (assignedType === "number" || typeof value === "number") { const parsed = parsePropertyNumber(input.value); if (parsed === null) { this.showError("Enter a finite number.", input); return; } next = parsed; }
        else if ((value === null || assignedType === "date" || assignedType === "datetime") && input.value === "") next = null;
        if (assignedType && !isPropertyTypeValue(assignedType, next)) { this.showError(`Enter a valid ${assignedType} value.`, input); return; }
        if (next !== value) commit(next); else { this.dirty = false; this.error = ""; this.refresh(true); }
      });
    }
    return input;
  }
  private list(container: HTMLElement, key: string, values: PropertyScalar[], editable: boolean, expected: unknown = values): void {
    container.classList.add("metadata-property-list");
    values.forEach((value, index) => {
      const item = document.createElement("div"); item.className = "metadata-list-item";
      item.append(this.valueInput(key, value, editable, next => this.apply({ kind: "set", key, value: values.map((previous, position) => position === index ? next : previous), expected }), index));
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "−"; remove.disabled = !editable; remove.setAttribute("aria-label", `Remove ${key} item ${index + 1}`); remove.addEventListener("click", () => this.apply({ kind: "set", key, value: values.filter((_, position) => position !== index), expected }));
      item.append(remove); container.append(item);
    });
    const add = document.createElement("button"); add.type = "button"; add.textContent = "+"; add.disabled = !editable; add.setAttribute("aria-label", `Add ${key} list item`); add.addEventListener("click", () => this.apply({ kind: "set", key, value: [...values, ""], expected })); container.append(add);
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
