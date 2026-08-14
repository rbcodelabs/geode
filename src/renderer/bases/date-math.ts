import moment from "moment";
import { DurationUnit } from "./value";

/** Canonical duration unit letters, per the spec's "Date arithmetic" section. */
const UNIT_LETTERS: ReadonlySet<string> = new Set(["y", "M", "w", "d", "h", "m", "s"]);

/** Maps every accepted spelling (long or short, singular or plural) to its canonical letter. */
const UNIT_WORDS: Record<string, DurationUnit> = {
  y: "y",
  year: "y",
  years: "y",
  M: "M",
  month: "M",
  months: "M",
  w: "w",
  week: "w",
  weeks: "w",
  d: "d",
  day: "d",
  days: "d",
  h: "h",
  hour: "h",
  hours: "h",
  m: "m",
  minute: "m",
  minutes: "m",
  s: "s",
  second: "s",
  seconds: "s",
};

/**
 * Parse a duration string in either compact (`"1M"`, `"2h"`) or spaced
 * (`"1 day"`, `"2 hours"`) form. The compact form's unit letter is
 * case-sensitive per the spec ("m" = minute, "M" = month); the spaced word
 * form is case-insensitive for convenience. Returns `null` (never throws)
 * for anything unrecognized.
 */
export function parseDuration(input: string): { amount: number; unit: DurationUnit } | null {
  const trimmed = input.trim();

  // Compact form: <number><single-letter-unit>, e.g. "1M", "2h".
  const compact = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z])$/);
  if (compact && UNIT_LETTERS.has(compact[2])) {
    return { amount: Number(compact[1]), unit: compact[2] as DurationUnit };
  }

  // Spaced form: <number> <word>, e.g. "1 day", "2 hours".
  const spaced = trimmed.match(/^(-?\d+(?:\.\d+)?)\s+([a-zA-Z]+)$/);
  if (spaced) {
    const unit = UNIT_WORDS[spaced[2].toLowerCase()];
    if (unit) return { amount: Number(spaced[1]), unit };
  }

  return null;
}

const MOMENT_UNIT: Record<DurationUnit, moment.unitOfTime.DurationConstructor> = {
  y: "years",
  M: "months",
  w: "weeks",
  d: "days",
  h: "hours",
  m: "minutes",
  s: "seconds",
};

/** Add a duration to an epoch-ms date, returning a new epoch-ms date. */
export function addDuration(epochMs: number, amount: number, unit: DurationUnit): number {
  return moment(epochMs).add(amount, MOMENT_UNIT[unit]).valueOf();
}

/**
 * Strict multi-format date parse, per the spec's `date(string)` function
 * (documented format `YYYY-MM-DD HH:mm:ss`) plus the common date-only and
 * ISO 8601 forms real frontmatter tends to use. Returns epoch ms, or `null`
 * if the string doesn't match any of the accepted formats.
 */
export function parseDateString(s: string): number | null {
  const m = moment(s, ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD", moment.ISO_8601], true);
  return m.isValid() ? m.valueOf() : null;
}

export function today(now: number): number {
  return moment(now).startOf("day").valueOf();
}

export function formatDate(epochMs: number, pattern: string): string {
  return moment(epochMs).format(pattern);
}

export function relativeDate(epochMs: number, now: number): string {
  return moment(epochMs).from(now);
}
