import moment from "moment";
import { ComparisonOp } from "./ast";
import { addDuration, parseDuration } from "./date-math";
import { BaseValue, bool, dateValue, durationValue, nullValue, num, str } from "./value";

/**
 * Truthiness per the spec: null->false, string->non-empty, number->non-zero
 * and not NaN, boolean->itself, date/duration->always true, list/object->
 * non-empty, link/file/regexp/html/image->true (these variants can only
 * exist with a real payload — a genuinely absent value is `BaseValue`
 * `{type:"null"}`, not a "null-ish" link/file/etc.).
 */
export function isTruthy(v: BaseValue): boolean {
  switch (v.type) {
    case "null":
      return false;
    case "string":
      return v.value.length > 0;
    case "number":
      return v.value !== 0 && !Number.isNaN(v.value);
    case "boolean":
      return v.value;
    case "date":
    case "duration":
      return true;
    case "list":
      return v.value.length > 0;
    case "object":
      return Object.keys(v.value).length > 0;
    case "link":
    case "file":
    case "regexp":
    case "html":
    case "image":
      return true;
  }
}

/**
 * Render a `BaseValue` as a display string — used by `.toString()`, string
 * concatenation via `+`, and anywhere else a value needs to become text.
 */
export function valueToDisplayString(v: BaseValue): string {
  switch (v.type) {
    case "null":
      return "";
    case "string":
      return v.value;
    case "number":
      return String(v.value);
    case "boolean":
      return String(v.value);
    case "date":
      return moment(v.value).format("YYYY-MM-DD HH:mm:ss");
    case "duration":
      return `${v.value.amount}${v.value.unit}`;
    case "list":
      return v.value.map(valueToDisplayString).join(", ");
    case "object":
      return `{${Object.entries(v.value)
        .map(([k, vv]) => `${k}: ${valueToDisplayString(vv)}`)
        .join(", ")}}`;
    case "link":
      return v.value.display ?? v.value.raw;
    case "file":
      return v.value.path;
    case "regexp":
      return `/${v.value.source}/${v.value.flags}`;
    case "html":
      return v.value;
    case "image":
      return v.value.source;
  }
}

/**
 * Structural equality, type-aware. Cross-type comparisons are always
 * unequal EXCEPT link<->file, which compares by resolved target file
 * identity (per the spec: "links... comparable to files with ==/!=").
 *
 * Link<->link with either side unresolved falls back to comparing raw link
 * text (a judgment call — the spec only specifies "equal if they point to
 * the same file"; two unresolved links are still meaningfully "equal" to a
 * formula author if they name the same target text).
 */
function valuesEqual(a: BaseValue, b: BaseValue): boolean {
  if (a.type === "link" && b.type === "file") {
    return !!a.value.resolved && a.value.resolved.path === b.value.path;
  }
  if (a.type === "file" && b.type === "link") {
    return !!b.value.resolved && b.value.resolved.path === a.value.path;
  }
  if (a.type !== b.type) return false;

  switch (a.type) {
    case "null":
      return true;
    case "string":
      return a.value === (b as typeof a).value;
    case "number":
      return a.value === (b as typeof a).value;
    case "boolean":
      return a.value === (b as typeof a).value;
    case "date":
      return a.value === (b as typeof a).value;
    case "duration": {
      const bb = b as typeof a;
      return a.value.amount === bb.value.amount && a.value.unit === bb.value.unit;
    }
    case "list": {
      const bb = b as typeof a;
      if (a.value.length !== bb.value.length) return false;
      return a.value.every((v, i) => valuesEqual(v, bb.value[i]));
    }
    case "object": {
      const bb = b as typeof a;
      const aKeys = Object.keys(a.value);
      const bKeys = Object.keys(bb.value);
      if (aKeys.length !== bKeys.length) return false;
      return aKeys.every((k) => k in bb.value && valuesEqual(a.value[k], bb.value[k]));
    }
    case "link": {
      const bb = b as typeof a;
      if (a.value.resolved && bb.value.resolved) return a.value.resolved.path === bb.value.resolved.path;
      if (!a.value.resolved && !bb.value.resolved) return a.value.raw === bb.value.raw;
      return false;
    }
    case "file": {
      const bb = b as typeof a;
      return a.value.path === bb.value.path;
    }
    case "regexp": {
      const bb = b as typeof a;
      return a.value.source === bb.value.source && a.value.flags === bb.value.flags;
    }
    case "html":
      return a.value === (b as typeof a).value;
    case "image": {
      const bb = b as typeof a;
      return a.value.source === bb.value.source;
    }
  }
}

/**
 * Type-aware comparison producing a boolean `BaseValue`. Equality
 * (`==`/`!=`) never fails — cross-type comparisons are simply unequal
 * (except the link/file special case in `valuesEqual`). Ordering
 * (`>,<,>=,<=`) is numeric for number/date, lexicographic for string, and
 * `null` `BaseValue` for anything else — callers collapse that to `false`
 * via `isTruthy`.
 */
export function compareValues(a: BaseValue, b: BaseValue, op: ComparisonOp): BaseValue {
  if (op === "==") return bool(valuesEqual(a, b));
  if (op === "!=") return bool(!valuesEqual(a, b));

  let ord: number | null = null;
  if (a.type === "number" && b.type === "number") ord = a.value - b.value;
  else if (a.type === "date" && b.type === "date") ord = a.value - b.value;
  else if (a.type === "string" && b.type === "string") ord = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;

  if (ord === null) return nullValue();

  switch (op) {
    case ">":
      return bool(ord > 0);
    case "<":
      return bool(ord < 0);
    case ">=":
      return bool(ord >= 0);
    case "<=":
      return bool(ord <= 0);
  }
}

/**
 * `+`: numeric addition for number+number; date+duration or
 * date+string-shaped-duration produces a date; otherwise, if either side is
 * a string, concatenates display-string forms (this also covers the
 * documented `price.toFixed(2) + " dollars"` formula pattern, since
 * `.toFixed()` already returns a string `BaseValue`). Anything else -> null.
 */
export function add(a: BaseValue, b: BaseValue): BaseValue {
  if (a.type === "number" && b.type === "number") return num(a.value + b.value);
  if (a.type === "date" && b.type === "duration") return dateValue(addDuration(a.value, b.value.amount, b.value.unit));
  if (a.type === "duration" && b.type === "date") return dateValue(addDuration(b.value, a.value.amount, a.value.unit));
  if (a.type === "date" && b.type === "string") {
    const dur = parseDuration(b.value);
    if (dur) return dateValue(addDuration(a.value, dur.amount, dur.unit));
  }
  if (a.type === "string" || b.type === "string") {
    return str(valueToDisplayString(a) + valueToDisplayString(b));
  }
  return nullValue();
}

/**
 * `-`: numeric subtraction for number-number; date-duration (or
 * date-string-shaped-duration) produces a date; date-date produces a
 * duration. The date-date unit is a judgment call not pinned down by the
 * spec — represented as an exact-seconds duration (fractional seconds
 * allowed) so no precision is lost regardless of the actual gap.
 */
export function subtract(a: BaseValue, b: BaseValue): BaseValue {
  if (a.type === "number" && b.type === "number") return num(a.value - b.value);
  if (a.type === "date" && b.type === "date") return durationValue((a.value - b.value) / 1000, "s");
  if (a.type === "date" && b.type === "duration") return dateValue(addDuration(a.value, -b.value.amount, b.value.unit));
  if (a.type === "date" && b.type === "string") {
    const dur = parseDuration(b.value);
    if (dur) return dateValue(addDuration(a.value, -dur.amount, dur.unit));
  }
  return nullValue();
}

export function multiply(a: BaseValue, b: BaseValue): BaseValue {
  if (a.type === "number" && b.type === "number") return num(a.value * b.value);
  return nullValue();
}

export function divide(a: BaseValue, b: BaseValue): BaseValue {
  if (a.type === "number" && b.type === "number") return num(a.value / b.value);
  return nullValue();
}

export function modulo(a: BaseValue, b: BaseValue): BaseValue {
  if (a.type === "number" && b.type === "number") return num(a.value % b.value);
  return nullValue();
}

/** Unary `-`: negates number or duration amount, else null. */
export function negate(v: BaseValue): BaseValue {
  if (v.type === "number") return num(-v.value);
  if (v.type === "duration") return durationValue(-v.value.amount, v.value.unit);
  return nullValue();
}
