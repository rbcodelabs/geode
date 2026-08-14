import type { TFile } from "../types";

/**
 * Duration unit letters accepted by the compact duration syntax (`"1M"`,
 * `"2h"`) — matches the spec's unit table exactly. Long/spaced forms
 * (`"1 day"`, `"2 hours"`) are normalized to one of these in date-math.ts
 * before a `BaseValue["duration"]` is constructed, so this is the only
 * canonical unit representation used at runtime.
 */
export type DurationUnit = "y" | "M" | "w" | "d" | "h" | "m" | "s";

export interface LinkValue {
  /** Raw target text as passed to link()/found in frontmatter, e.g. "Some Note" or "Some Note|Display". */
  raw: string;
  display?: string;
  /** Resolved target file, or null if the link doesn't resolve to a vault file. */
  resolved: TFile | null;
}

export interface RegexpValue {
  source: string;
  flags: string;
}

export interface ImageValue {
  source: string;
}

/**
 * The runtime value type for the Bases expression engine. Every expression
 * evaluates to exactly one of these variants — a tagged union keyed by
 * `type`, deliberately mirroring the type list in the spec's "Type system"
 * section one-for-one.
 */
export type BaseValue =
  | { type: "null" }
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "date"; value: number } // epoch ms
  | { type: "duration"; value: { amount: number; unit: DurationUnit } }
  | { type: "list"; value: BaseValue[] }
  | { type: "object"; value: Record<string, BaseValue> }
  | { type: "link"; value: LinkValue }
  | { type: "file"; value: TFile }
  | { type: "regexp"; value: RegexpValue }
  | { type: "html"; value: string }
  | { type: "image"; value: ImageValue };

export function nullValue(): BaseValue {
  return { type: "null" };
}

export function str(value: string): BaseValue {
  return { type: "string", value };
}

export function num(value: number): BaseValue {
  return { type: "number", value };
}

export function bool(value: boolean): BaseValue {
  return { type: "boolean", value };
}

export function dateValue(epochMs: number): BaseValue {
  return { type: "date", value: epochMs };
}

export function durationValue(amount: number, unit: DurationUnit): BaseValue {
  return { type: "duration", value: { amount, unit } };
}

export function listValue(items: BaseValue[]): BaseValue {
  return { type: "list", value: items };
}

export function objectValue(entries: Record<string, BaseValue>): BaseValue {
  return { type: "object", value: entries };
}

export function linkValue(raw: string, resolved: TFile | null, display?: string): BaseValue {
  return { type: "link", value: { raw, display, resolved } };
}

export function fileValue(file: TFile): BaseValue {
  return { type: "file", value: file };
}

export function regexpValue(source: string, flags: string): BaseValue {
  return { type: "regexp", value: { source, flags } };
}

export function htmlValue(value: string): BaseValue {
  return { type: "html", value };
}

export function imageValue(source: string): BaseValue {
  return { type: "image", value: { source } };
}
