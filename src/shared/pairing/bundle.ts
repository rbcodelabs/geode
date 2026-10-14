import { hubUrlProblem } from "../hub-sync";
import { validatePortableConfig, type PortableConfigValues } from "../portable-config";
import { PairingError } from "./errors";

/** The hub provider's id (asserted equal to HUB_PROVIDER_ID in tests; shared code must not import renderer modules). */
export const PAIRING_PROVIDER_HUB = "geode.hub";
export const MAX_BUNDLE_BYTES = 256 * 1024;
export const MAX_CREDENTIAL_CHARS = 8192;

export interface PairingPortable {
  editor?: PortableConfigValues["editor.json"];
  appearance?: PortableConfigValues["appearance.json"];
  hotkeys?: PortableConfigValues["hotkeys.json"];
  dailyNotes?: PortableConfigValues["daily-notes.json"];
}
/** What the encrypted reply holds. Never includes plugin lists, plugin data, workspace state or a local folder/ssh hub target. */
export interface PairingBundle {
  v: 1;
  provider: { id: typeof PAIRING_PROVIDER_HUB; config: { url: string } };
  vault: { id: string; name: string } | null;
  portable: PairingPortable;
  credential: { scheme: "bearer"; value: string } | null;
  from: string;
}

const CATEGORY_FILES = { editor: "editor.json", appearance: "appearance.json", hotkeys: "hotkeys.json", dailyNotes: "daily-notes.json" } as const;
export const PORTABLE_CATEGORIES = Object.keys(CATEGORY_FILES) as Array<keyof typeof CATEGORY_FILES>;
export const portableFileName = (key: keyof typeof CATEGORY_FILES) => CATEGORY_FILES[key];

const bad = (): never => { throw new PairingError("invalid-bundle", "The pairing data from your computer was not valid, so nothing was changed."); };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function keysOf(value: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  if (!isObject(value)) return bad();
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) return bad();
  return value;
}
const text = (value: unknown, max: number, nonEmpty: boolean): string => {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || value.length > max || (nonEmpty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) return bad();
  return value;
};

/** Strict, total validation of untrusted decrypted JSON. Throws PairingError("invalid-bundle"); the message never echoes content. */
export function parseBundle(raw: unknown): PairingBundle {
  const top = keysOf(raw, ["v", "provider", "vault", "portable", "credential", "from"], ["v", "provider", "vault", "portable", "credential", "from"]);
  if (top.v !== 1) throw new PairingError("unsupported-version", "Your computer is using a newer pairing format. Update Geode on this device.");
  const provider = keysOf(top.provider, ["id", "config"], ["id", "config"]);
  if (provider.id !== PAIRING_PROVIDER_HUB) throw new PairingError("unsupported-provider", "This sync provider can't be set up on this device.");
  const config = keysOf(provider.config, ["url"], ["url"]);
  if (typeof config.url !== "string" || hubUrlProblem(config.url) !== null) bad();
  let vault: PairingBundle["vault"] = null;
  if (top.vault !== null) {
    const v = keysOf(top.vault, ["id", "name"], ["id", "name"]);
    if (typeof v.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.id)) bad();
    vault = { id: v.id as string, name: text(v.name, 128, true) };
  }
  const portableRaw = keysOf(top.portable, PORTABLE_CATEGORIES, []);
  const portable: PairingPortable = {};
  for (const key of PORTABLE_CATEGORIES) {
    if (!(key in portableRaw)) continue;
    try { (portable as Record<string, unknown>)[key] = validatePortableConfig(CATEGORY_FILES[key], portableRaw[key]).value; } catch { bad(); }
  }
  let credential: PairingBundle["credential"] = null;
  if (top.credential !== null) {
    const c = keysOf(top.credential, ["scheme", "value"], ["scheme", "value"]);
    if (c.scheme !== "bearer") bad();
    credential = { scheme: "bearer", value: text(c.value, MAX_CREDENTIAL_CHARS, true) };
  }
  return { v: 1, provider: { id: PAIRING_PROVIDER_HUB, config: { url: config.url as string } }, vault, portable, credential, from: text(top.from, 64, false) };
}

/** Desktop side: validates by round-tripping through the same parser the phone uses, and enforces the size cap. */
export function serializeBundle(bundle: PairingBundle): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(parseBundle(JSON.parse(JSON.stringify(bundle)))));
  if (bytes.length > MAX_BUNDLE_BYTES) throw new PairingError("invalid-bundle", "Your settings are too large to pair (for example, a very large hotkey list).");
  return bytes;
}
