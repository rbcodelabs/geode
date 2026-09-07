/**
 * Obsidian's Bases `Value` class hierarchy.
 *
 * Geode's expression engine (`../bases/value.ts`) represents a value as a
 * tagged union of plain objects — cheap, exhaustively switchable, and exactly
 * what the evaluator wants internally. Obsidian's *public* Bases API instead
 * hands views a class instance with `toString()`, `isTruthy()` and
 * `renderTo()`, and plugins branch on it with `instanceof`:
 *
 *     if (!value || value instanceof NullValue) return;
 *     value.renderTo(el, ctx.app.renderContext);
 *
 * `instanceof` means a structurally-identical parallel type is useless — the
 * null a view receives has to be an instance of the very class the view
 * imported. So these classes are the boundary representation, produced by
 * `toApiValue()` when a `BasesEntry` hands a value out, and every wrapper
 * defers its text and truthiness to `../bases/coerce.ts` so the API layer can
 * never disagree with the engine about what a value means.
 */
import { isTruthy as isTruthyBase, compareValues, valueToDisplayString } from "../bases/coerce";
import type { BaseValue, DurationUnit } from "../bases/value";
import type { TFile } from "../types";
import { sanitizeHTMLToDom } from "./obsidian-dom";

/**
 * Utility object passed to `Value.renderTo`. Obsidian's carries hover-preview
 * state; Geode has no hover-preview infrastructure (see `App.hoverLinkSources`,
 * which is store-only for the same reason), so `hoverPopover` is present for
 * shape compatibility and stays null — nothing here ever constructs a popover.
 */
export class RenderContext {
  hoverPopover: unknown = null;
}

/** Base type for every Bases value. */
export abstract class Value {
  /** The engine-level tagged value this wraps. */
  abstract readonly baseValue: BaseValue;

  /** Type discriminator, mirroring `Value.type` in the Obsidian API. */
  static type = "";

  toString(): string {
    return valueToDisplayString(this.baseValue);
  }

  isTruthy(): boolean {
    return isTruthyBase(this.baseValue);
  }

  equals(other: Value): boolean {
    return Value.equals(this, other);
  }

  looseEquals(other: Value): boolean {
    return Value.looseEquals(this, other);
  }

  static equals(a: Value | null, b: Value | null): boolean {
    if (a === null || b === null) return a === b;
    if (a.baseValue.type !== b.baseValue.type) return false;
    return isTruthyBase(compareValues(a.baseValue, b.baseValue, "=="));
  }

  /**
   * Cross-type equality, delegating to the engine's comparison rules (which
   * already relate e.g. a link to the file it resolves to).
   */
  static looseEquals(a: Value | null, b: Value | null): boolean {
    if (a === null || b === null) return a === b;
    return isTruthyBase(compareValues(a.baseValue, b.baseValue, "=="));
  }

  /**
   * Render this value into `el`. The default is plain text; subclasses that
   * have a richer representation (links, lists, images, HTML) override it.
   */
  renderTo(el: HTMLElement, _ctx: RenderContext): void {
    el.textContent = this.toString();
  }
}

/** Base type for all non-null values. */
export abstract class NotNullValue extends Value {}

/** Base type for values wrapping a single JS primitive. */
export abstract class PrimitiveValue<T> extends NotNullValue {
  constructor(readonly data: T) {
    super();
  }
}

/**
 * The null value. A singleton: `NullValue.value` is the only instance the
 * adapters ever produce, so a view's `value instanceof NullValue` check and a
 * `value === NullValue.value` identity check agree.
 */
export class NullValue extends Value {
  static override type = "null";
  static readonly value = new NullValue();

  readonly baseValue: BaseValue = { type: "null" };

  override toString(): string {
    return "";
  }

  override isTruthy(): boolean {
    return false;
  }
}

export class StringValue extends PrimitiveValue<string> {
  static override type = "string";
  readonly baseValue: BaseValue;
  constructor(data: string) {
    super(data);
    this.baseValue = { type: "string", value: data };
  }
}

export class NumberValue extends PrimitiveValue<number> {
  static override type = "number";
  readonly baseValue: BaseValue;
  constructor(data: number) {
    super(data);
    this.baseValue = { type: "number", value: data };
  }
}

export class BooleanValue extends PrimitiveValue<boolean> {
  static override type = "boolean";
  readonly baseValue: BaseValue;
  constructor(data: boolean) {
    super(data);
    this.baseValue = { type: "boolean", value: data };
  }
}

export class DateValue extends NotNullValue {
  static override type = "date";
  readonly baseValue: BaseValue;
  /** @param epochMs milliseconds since the epoch, matching the engine's `date` arm. */
  constructor(readonly epochMs: number) {
    super();
    this.baseValue = { type: "date", value: epochMs };
  }
}

export class DurationValue extends NotNullValue {
  static override type = "duration";
  readonly baseValue: BaseValue;
  constructor(readonly amount: number, readonly unit: DurationUnit) {
    super();
    this.baseValue = { type: "duration", value: { amount, unit } };
  }
}

export class ListValue extends NotNullValue {
  static override type = "list";
  readonly baseValue: BaseValue;
  constructor(readonly items: Value[]) {
    super();
    this.baseValue = { type: "list", value: items.map((i) => i.baseValue) };
  }

  /** Render each item through its own `renderTo`, so a list of links stays clickable. */
  override renderTo(el: HTMLElement, ctx: RenderContext): void {
    this.items.forEach((item, i) => {
      if (i > 0) el.appendChild(document.createTextNode(", "));
      const span = document.createElement("span");
      item.renderTo(span, ctx);
      el.appendChild(span);
    });
  }
}

export class ObjectValue extends NotNullValue {
  static override type = "object";
  readonly baseValue: BaseValue;
  constructor(readonly entries: Record<string, Value>) {
    super();
    const value: Record<string, BaseValue> = {};
    for (const [k, v] of Object.entries(entries)) value[k] = v.baseValue;
    this.baseValue = { type: "object", value };
  }

  isEmpty(): boolean {
    return Object.keys(this.entries).length === 0;
  }

  /** @returns the value at `key`, or `NullValue.value` if absent. */
  get(key: string): Value {
    return this.entries[key] ?? NullValue.value;
  }
}

/**
 * An internal wikilink. Obsidian models this as a `StringValue` subclass, so
 * `toString()` yields the link's display text.
 *
 * `renderTo` is load-bearing well beyond cosmetics: Obsidian's convention is
 * an `<a class="internal-link" data-href="...">`, and views wire their
 * navigation with a delegated `containerEl.on('click', 'a.internal-link', …)`
 * handler that reads `data-href`. Emit anything else and links in a hosted
 * view render but silently do nothing when clicked.
 */
export class LinkValue extends StringValue {
  static override type = "link";
  readonly baseValue: BaseValue;

  constructor(readonly raw: string, readonly resolved: TFile | null, readonly display?: string) {
    super(display ?? raw);
    this.baseValue = { type: "link", value: { raw, display, resolved } };
  }

  override renderTo(el: HTMLElement, _ctx: RenderContext): void {
    const a = document.createElement("a");
    a.className = "internal-link";
    a.setAttribute("data-href", this.raw);
    a.setAttribute("href", this.raw);
    if (!this.resolved) a.classList.add("is-unresolved");
    a.textContent = this.display ?? this.raw;
    el.appendChild(a);
  }
}

export class FileValue extends NotNullValue {
  static override type = "file";
  readonly baseValue: BaseValue;
  constructor(readonly file: TFile) {
    super();
    this.baseValue = { type: "file", value: file };
  }

  /** A file renders as a link to itself, for the same click-through reason as `LinkValue`. */
  override renderTo(el: HTMLElement, ctx: RenderContext): void {
    new LinkValue(this.file.path, this.file, this.file.basename).renderTo(el, ctx);
  }
}

export class ImageValue extends StringValue {
  static override type = "image";
  readonly baseValue: BaseValue;
  constructor(readonly source: string) {
    super(source);
    this.baseValue = { type: "image", value: { source } };
  }

  override renderTo(el: HTMLElement, _ctx: RenderContext): void {
    const img = document.createElement("img");
    img.setAttribute("src", this.source);
    img.setAttribute("alt", "");
    el.appendChild(img);
  }
}

/**
 * Geode extension. The Obsidian API publishes no class for the engine's
 * `regexp` arm, but `toApiValue` must be total — an unmapped arm would mean a
 * view silently receiving the wrong type.
 */
export class RegexpValue extends NotNullValue {
  static override type = "regexp";
  readonly baseValue: BaseValue;
  constructor(readonly source: string, readonly flags: string) {
    super();
    this.baseValue = { type: "regexp", value: { source, flags } };
  }
}

/** Geode extension, for the engine's `html` arm — see `RegexpValue`. */
export class HtmlValue extends NotNullValue {
  static override type = "html";
  readonly baseValue: BaseValue;
  constructor(readonly html: string) {
    super();
    this.baseValue = { type: "html", value: html };
  }

  override renderTo(el: HTMLElement, _ctx: RenderContext): void {
    el.appendChild(sanitizeHTMLToDom(this.html));
  }
}

/**
 * Lift an engine value into its public API class. Total over every arm of
 * `BaseValue` — the exhaustiveness check at the bottom is a compile error if
 * an arm is ever added to the union without being handled here.
 */
export function toApiValue(v: BaseValue): Value {
  switch (v.type) {
    case "null":
      return NullValue.value;
    case "string":
      return new StringValue(v.value);
    case "number":
      return new NumberValue(v.value);
    case "boolean":
      return new BooleanValue(v.value);
    case "date":
      return new DateValue(v.value);
    case "duration":
      return new DurationValue(v.value.amount, v.value.unit);
    case "list":
      return new ListValue(v.value.map(toApiValue));
    case "object": {
      const entries: Record<string, Value> = {};
      for (const [k, vv] of Object.entries(v.value)) entries[k] = toApiValue(vv);
      return new ObjectValue(entries);
    }
    case "link":
      return new LinkValue(v.value.raw, v.value.resolved, v.value.display);
    case "file":
      return new FileValue(v.value);
    case "regexp":
      return new RegexpValue(v.value.source, v.value.flags);
    case "html":
      return new HtmlValue(v.value);
    case "image":
      return new ImageValue(v.value.source);
    default: {
      const exhaustive: never = v;
      throw new Error(`Unhandled BaseValue arm: ${JSON.stringify(exhaustive)}`);
    }
  }
}
