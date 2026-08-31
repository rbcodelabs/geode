/** Physical-key hotkey normalization shared by renderer and Electron main. */
export type HotkeyModifier = "Mod" | "Ctrl" | "Meta" | "Alt" | "Shift";
export interface Hotkey { modifiers: HotkeyModifier[]; code: string }
export type HotkeyPlatform = "mac" | "other";
const ORDER: HotkeyModifier[] = ["Mod", "Ctrl", "Meta", "Alt", "Shift"];
const MODIFIER_CODES = new Set(["Meta", "Control", "Alt", "Shift", "MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight"]);

export function normalizeHotkey(value: unknown): Hotkey | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { modifiers?: unknown; code?: unknown };
  if (!Array.isArray(raw.modifiers) || typeof raw.code !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(raw.code) || MODIFIER_CODES.has(raw.code)) return null;
  if (raw.modifiers.some(m => !ORDER.includes(m as HotkeyModifier))) return null;
  const modifiers = [...new Set(raw.modifiers as HotkeyModifier[])].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  if (modifiers.length !== raw.modifiers.length) return null;
  return { modifiers, code: raw.code };
}
export function bindingIdentity(binding: Hotkey): string { const value = normalizeHotkey(binding); return value ? [...value.modifiers, value.code].join("+") : ""; }

const LEGACY_CODES: Record<string, string> = { ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "-": "Minus", "=": "Equal", "`": "Backquote", " ": "Space" };
export function legacyHotkeyToBinding(combo: string): Hotkey | null {
  const parts = combo.split("+").filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  let code = LEGACY_CODES[key] ?? key;
  if (/^[a-z]$/i.test(code)) code = `Key${code.toUpperCase()}`;
  else if (/^[0-9]$/.test(code)) code = `Digit${code}`;
  return normalizeHotkey({ modifiers: parts, code });
}
export function rendererHotkeyPlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): HotkeyPlatform { return /Mac|iPhone|iPad/.test(platform) ? "mac" : "other"; }
export function nodeHotkeyPlatform(platform: NodeJS.Platform): HotkeyPlatform { return platform === "darwin" ? "mac" : "other"; }
function modifiersFromFlags(meta: boolean, control: boolean, alt: boolean, shift: boolean, platform: HotkeyPlatform): HotkeyModifier[] {
  const mac = platform === "mac";
  const result: HotkeyModifier[] = [];
  if ((mac && meta) || (!mac && control)) result.push("Mod");
  if (mac ? control : meta) result.push(mac ? "Ctrl" : "Meta");
  if (alt) result.push("Alt");
  if (shift) result.push("Shift");
  return result;
}
export function eventToBinding(e: KeyboardEvent, platform: HotkeyPlatform = rendererHotkeyPlatform()): Hotkey | null { return normalizeHotkey({ modifiers: modifiersFromFlags(e.metaKey, e.ctrlKey, e.altKey, e.shiftKey, platform), code: e.code }); }
export function eventToHotkey(e: KeyboardEvent, platform: HotkeyPlatform = rendererHotkeyPlatform()): string { const value = eventToBinding(e, platform); return value ? bindingIdentity(value) : ""; }
export interface HotkeyInput { type: string; key: string; code?: string; control: boolean; meta: boolean; alt: boolean; shift: boolean }
export function inputToBinding(input: HotkeyInput, platform: HotkeyPlatform): Hotkey | null {
  if (input.type !== "keyDown" || !input.code) return null;
  return normalizeHotkey({ modifiers: modifiersFromFlags(input.meta, input.control, input.alt, input.shift, platform), code: input.code });
}
export function inputToHotkey(input: HotkeyInput, platform: HotkeyPlatform = "other"): string { const value = inputToBinding(input, platform); return value ? bindingIdentity(value) : ""; }
export function resolveGuestHotkey(input: HotkeyInput, combos: ReadonlySet<string> | readonly string[], platform: HotkeyPlatform = "other"): string | null {
  const combo = inputToHotkey(input, platform);
  if (!combo) return null;
  return (Array.isArray(combos) ? combos.includes(combo) : (combos as ReadonlySet<string>).has(combo)) ? combo : null;
}
const CODE_LABELS: Record<string, string> = { Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`", Space: "Space" };
export function displayHotkey(binding: Hotkey, platform = typeof navigator === "undefined" ? "" : navigator.platform): string {
  const value = normalizeHotkey(binding);
  if (!value) return "";
  const mac = /Mac|iPhone|iPad/.test(platform);
  const labels = value.modifiers.map(m => mac ? ({ Mod: "⌘", Ctrl: "⌃", Meta: "⌘", Alt: "⌥", Shift: "⇧" }[m]) : (m === "Mod" ? "Ctrl" : m));
  const key = CODE_LABELS[value.code] ?? value.code.replace(/^Key/, "").replace(/^Digit/, "");
  return mac ? `${labels.join("")}${key}` : [...labels, key].join("+");
}
/** Deprecated compatibility helper retained for existing importers. */
export interface HotkeyParts { mod: boolean; alt: boolean; shift: boolean; key: string }
export function comboFromParts(parts: HotkeyParts): string {
  if (!parts.key) return "";
  const value = legacyHotkeyToBinding([parts.mod && "Mod", parts.alt && "Alt", parts.shift && "Shift", parts.key === " " ? "Space" : parts.key].filter(Boolean).join("+"));
  return value ? bindingIdentity(value) : "";
}
