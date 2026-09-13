import type { ConfigService } from '../renderer/host/contracts';
import type { SyncScope } from '../renderer/sync/scope';
import { normalizeHotkey, type Hotkey } from './hotkey';
import type { DailyNotesConfig } from '../renderer/daily-notes';
import moment from 'moment';

export interface PortableConfigValues {
  'editor.json': { readableLineLength: boolean; foldHeading: boolean; showLineNumber: boolean; showRibbon: boolean; showStatusBar: boolean };
  'appearance.json': { theme: 'dark' | 'light'; baseFontSize: number; cssTheme: string };
  'hotkeys.json': { version: 1; overrides: Record<string, Hotkey[]> };
  'daily-notes.json': DailyNotesConfig;
}
export type PortableConfigName = keyof PortableConfigValues;
export type PortableConfigDocument = { [K in PortableConfigName]: { name: K; value: PortableConfigValues[K] } }[PortableConfigName];
export interface PortableConfigOwners {
  applyEditor(patch: PortableConfigValues['editor.json']): Promise<void>;
  applyAppearance(patch: PortableConfigValues['appearance.json']): Promise<void>;
  applyHotkeys(patch: PortableConfigValues['hotkeys.json']): Promise<void>;
  applyDailyNotes(patch: PortableConfigValues['daily-notes.json']): Promise<void>;
}

// AppSettings is private to App; mirror only its explicitly approved portable defaults.
const EDITOR_DEFAULTS: PortableConfigValues['editor.json'] = { readableLineLength: true, foldHeading: false, showLineNumber: false, showRibbon: true, showStatusBar: true };
const APPEARANCE_DEFAULTS: PortableConfigValues['appearance.json'] = { theme: 'dark', baseFontSize: 16, cssTheme: '' };
const DAILY_DEFAULTS = { enabled: true, folder: '', format: 'YYYY-MM-DD', template: '' };
const utf8 = new TextEncoder();
const MAX_CONFIG_BYTES = 1024 * 1024;

function invalid(): never { throw new TypeError('Invalid portable configuration'); }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value,key))) return invalid();
  return value;
}
function sourceObject(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (!isObject(raw)) return invalid();
  return raw;
}
function projectFields(raw: unknown, defaults: object): Record<string, unknown> {
  const source = sourceObject(raw);
  return Object.fromEntries(Object.entries(defaults).map(([key,value]) => [key, Object.prototype.hasOwnProperty.call(source,key) ? source[key] : value]));
}
function safeComponent(value: string): boolean {
  return value.length > 0 && utf8.encode(value).byteLength <= 255 && value === value.normalize('NFC')
    && !/[\x00-\x1f\x7f/\\:*?"<>|]/.test(value) && !/[. ]$/.test(value)
    && !/^(\.|\.\.|\.geode|\.geode-trash|\.obsidian|\.git|\.trash)$/i.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function relativePath(value: unknown, emptyAllowed: boolean): value is string {
  if (typeof value !== 'string') return false;
  if (value === '') return emptyAllowed;
  return value.split('/').every(safeComponent);
}
function safeDailyFormat(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || !relativePath(value.replace(/[\[\]]/g,''),false)) return false;
  // Expanded shorthand tokens (e.g. LTS) can introduce invalid filename characters
  // absent from the format itself. Keep validation independent of device locale.
  return Array.from({length:12},(_,month)=>month).every(month =>
    relativePath(`${moment.utc([2024,month,15,13,14,15]).locale('en').format(value)}.md`,false));
}
function validateHotkeys(value: unknown): PortableConfigValues['hotkeys.json'] {
  const raw = exactObject(value,['version','overrides']);
  if (raw.version !== 1 || !isObject(raw.overrides)) return invalid();
  const overrides: Record<string,Hotkey[]> = Object.create(null) as Record<string,Hotkey[]>;
  for (const [id,bindings] of Object.entries(raw.overrides)) {
    if (!id || id.length > 512 || /[\x00-\x1f\x7f]/.test(id) || ['__proto__','prototype','constructor'].includes(id) || !Array.isArray(bindings)) return invalid();
    overrides[id] = bindings.map(binding => {
      exactObject(binding,['code','modifiers']);
      const normalized = normalizeHotkey(binding);
      if (!normalized) return invalid();
      return normalized;
    });
  }
  return { version: 1, overrides };
}
function validateDocument(name: string, value: unknown): PortableConfigDocument {
  switch (name) {
    case 'editor.json': {
      const raw = exactObject(value,Object.keys(EDITOR_DEFAULTS));
      if (Object.values(raw).some(field => typeof field !== 'boolean')) return invalid();
      return { name, value: { readableLineLength: raw.readableLineLength as boolean, foldHeading: raw.foldHeading as boolean,
        showLineNumber: raw.showLineNumber as boolean, showRibbon: raw.showRibbon as boolean, showStatusBar: raw.showStatusBar as boolean } };
    }
    case 'appearance.json': {
      const raw = exactObject(value,Object.keys(APPEARANCE_DEFAULTS));
      if ((raw.theme !== 'dark' && raw.theme !== 'light') || typeof raw.baseFontSize !== 'number' || !Number.isFinite(raw.baseFontSize) || raw.baseFontSize <= 0
        || typeof raw.cssTheme !== 'string' || (raw.cssTheme !== '' && !safeComponent(raw.cssTheme))) return invalid();
      return { name, value: { theme: raw.theme, baseFontSize: raw.baseFontSize, cssTheme: raw.cssTheme } };
    }
    case 'hotkeys.json': return { name, value: validateHotkeys(value) };
    case 'daily-notes.json': {
      const raw = exactObject(value,Object.keys(DAILY_DEFAULTS));
      // Moment literals use square brackets; checking the literal path skeleton also
      // rejects traversal hidden inside formats such as "[../]YYYY".
      if (typeof raw.enabled !== 'boolean' || !relativePath(raw.folder,true) || !relativePath(raw.template,true) || !safeDailyFormat(raw.format)) return invalid();
      return { name, value: { enabled: raw.enabled, folder: raw.folder, format: raw.format, template: raw.template } };
    }
    default: return invalid();
  }
}

/** Read only selected source files and discard all nonportable fields before validation. */
export async function projectPortableConfig(config: Pick<ConfigService,'read'>, scope: Readonly<SyncScope>): Promise<PortableConfigDocument[]> {
  const documents: PortableConfigDocument[] = [];
  if (scope.mainSettings || scope.appearance) {
    const app = await config.read('app');
    if (scope.mainSettings) documents.push(validateDocument('editor.json',projectFields(app,EDITOR_DEFAULTS)));
    if (scope.appearance) documents.push(validateDocument('appearance.json',projectFields(app,APPEARANCE_DEFAULTS)));
  }
  if (scope.hotkeys) {
    const raw = sourceObject(await config.read('hotkeys'));
    const value = projectFields(raw,{version:1,overrides:{}});
    if (!isObject(value.overrides)) return invalid();
    // Unknown local fields are never exported, even inside otherwise valid bindings.
    value.overrides = Object.fromEntries(Object.entries(value.overrides).map(([id,bindings]) => [id,
      Array.isArray(bindings) ? bindings.map(binding => {
        if (!isObject(binding)) return invalid();
        return { code: binding.code, modifiers: binding.modifiers };
      }) : bindings,
    ]));
    documents.push(validateDocument('hotkeys.json',value));
  }
  if (scope.corePlugins) documents.push(validateDocument('daily-notes.json',projectFields(await config.read('daily-notes'),DAILY_DEFAULTS)));
  return documents;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Wire bytes contain one complete logical category, never a raw host config file. */
export function serializePortableConfig(document: PortableConfigDocument): ArrayBuffer {
  const validated = validateDocument(document.name,document.value);
  const bytes = utf8.encode(canonicalJson(validated.value));
  if (bytes.byteLength > MAX_CONFIG_BYTES) return invalid();
  return bytes.buffer;
}

export function parsePortableConfig(name: string, bytes: ArrayBuffer): PortableConfigDocument {
  if (bytes.byteLength > MAX_CONFIG_BYTES) return invalid();
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown; } catch { return invalid(); }
  return validateDocument(name,raw);
}

/** Callers retain generation/hash guards; owning services merge, persist and refresh. */
export async function applyPortableConfig(document: PortableConfigDocument, owners: PortableConfigOwners): Promise<void> {
  const validated = validateDocument(document.name,document.value);
  switch (validated.name) {
    case 'editor.json': return owners.applyEditor(validated.value);
    case 'appearance.json': return owners.applyAppearance(validated.value);
    case 'hotkeys.json': return owners.applyHotkeys(validated.value);
    case 'daily-notes.json': return owners.applyDailyNotes(validated.value);
  }
}
