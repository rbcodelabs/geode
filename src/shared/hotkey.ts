/**
 * Hotkey combo normalization, shared by the renderer and the main process.
 *
 * Hotkeys are registered in the renderer (`CommandRegistry`), but keystrokes
 * inside a `<webview>` guest are delivered to the guest's own process and
 * never reach the host document. Main bridges them back via
 * `before-input-event`, which means main and renderer have to derive the
 * exact same combo string from two different event shapes: a DOM
 * `KeyboardEvent` and Electron's `Input`. That agreement lives here.
 *
 * esbuild bundles each entry point separately, so importing this from both
 * `src/main` and `src/renderer` needs no build configuration.
 */

export interface HotkeyParts {
  /** Cmd on macOS, Ctrl elsewhere. Geode treats them interchangeably. */
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** The single source of truth for the `"Mod+Shift+K"` combo format. */
export function comboFromParts({ mod, alt, shift, key }: HotkeyParts): string {
  let normalized = key;
  if (normalized === " ") normalized = "Space";
  if (normalized.length === 1) normalized = normalized.toUpperCase();
  // A modifier pressed on its own is not a combo, it is the prefix of one.
  if (!normalized || MODIFIER_KEYS.has(normalized)) return "";
  const parts: string[] = [];
  if (mod) parts.push("Mod");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");
  parts.push(normalized);
  return parts.join("+");
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift"]);

/** Normalize a DOM KeyboardEvent into "Mod+Shift+K" style strings. */
export function eventToHotkey(e: KeyboardEvent): string {
  return comboFromParts({
    mod: e.metaKey || e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key: e.key,
  });
}

/**
 * The subset of Electron's `Input` this module needs. Declared structurally
 * rather than importing `Electron.Input` so the renderer bundle does not have
 * to pull in Electron's types.
 */
export interface HotkeyInput {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * Normalize an Electron `before-input-event` input. Only `keyDown` produces a
 * combo: `keyUp`/`char`/`rawKeyDown` for the same press would otherwise fire
 * the bound command two or three times per keystroke.
 */
export function inputToHotkey(input: HotkeyInput): string {
  if (input.type !== "keyDown") return "";
  return comboFromParts({
    mod: input.meta || input.control,
    alt: input.alt,
    shift: input.shift,
    key: input.key,
  });
}

/**
 * The combo a guest keystroke should be forwarded to the host as, or null if
 * the renderer has nothing bound to it. Null means "leave this key alone":
 * ordinary page and OS shortcuts such as Cmd+A and Cmd+C must keep working
 * inside a web page.
 */
export function resolveGuestHotkey(
  input: HotkeyInput,
  combos: ReadonlySet<string> | readonly string[],
): string | null {
  const combo = inputToHotkey(input);
  if (!combo) return null;
  const bound = Array.isArray(combos) ? combos.includes(combo) : (combos as ReadonlySet<string>).has(combo);
  return bound ? combo : null;
}
