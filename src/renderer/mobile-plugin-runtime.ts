import * as GeodeAPI from "./api/obsidian";
import * as CodeMirrorState from "@codemirror/state";
import * as CodeMirrorView from "@codemirror/view";
import * as CodeMirrorCommands from "@codemirror/commands";
import * as CodeMirrorLanguage from "@codemirror/language";
import * as CodeMirrorAutocomplete from "@codemirror/autocomplete";
import * as LezerCommon from "@lezer/common";
import * as LezerHighlight from "@lezer/highlight";
import type { Plugin } from "./plugin";
import type { PluginManifest } from "./plugin-manifest";
import type { App } from "./app";
import { ImportType, init as rawModuleLexerInit, parse as rawParseModuleSyntax } from "es-module-lexer";

export type MobilePluginCompatibility = "mobile-compatible" | "desktop-only" | "unknown";

export interface MobilePluginAdmission {
  compatibility: MobilePluginCompatibility;
  label: "Mobile compatible" | "Desktop only" | "Unknown";
  reason: string;
  allowed: boolean;
}

type PluginConstructor = new (app: App, manifest: PluginManifest) => Plugin;
export type MobilePluginModuleErrorCode =
  | "MOBILE_PLUGIN_SOURCE_TOO_LARGE"
  | "MOBILE_PLUGIN_PREFLIGHT_FAILED"
  | "MOBILE_PLUGIN_STATIC_IMPORT"
  | "MOBILE_PLUGIN_DYNAMIC_IMPORT"
  | "MOBILE_PLUGIN_DYNAMIC_IMPORT_EXPRESSION"
  | "MOBILE_PLUGIN_IMPORT_META"
  | "MOBILE_PLUGIN_ESM_EXPORT"
  | "MOBILE_PLUGIN_MODULE_SYNTAX_INVALID";

export class MobilePluginModuleError extends Error {
  constructor(readonly code: MobilePluginModuleErrorCode, pluginId: string, detail: string) {
    super(`${code}: Mobile plugin "${pluginId}" ${detail}`);
    this.name = "MobilePluginModuleError";
  }
}
export const MAX_MOBILE_PLUGIN_SOURCE_BYTES = 16 * 1024 * 1024;

type ModuleParser = typeof rawParseModuleSyntax;
let parseModuleSyntax: ModuleParser = rawParseModuleSyntax;
let moduleLexerFailure: string | null = null;
let moduleLexerReady!: Promise<void>;

function sanitizePreflightFailure(error: unknown): string {
  return error instanceof Error
    ? error.name.slice(0, 80).replace(/[^a-zA-Z0-9 _.-]/g, "?")
    : "Unknown failure";
}

function attachModuleLexer(init: PromiseLike<unknown>, parser: ModuleParser): void {
  moduleLexerFailure = null;
  parseModuleSyntax = parser;
  // Attach the rejection branch synchronously. The stored promise always
  // fulfills, so neither the raw initialization nor a derived promise can
  // surface as an unhandled rejection before a vault asks to load a plugin.
  moduleLexerReady = Promise.resolve(init).then(
    () => {},
    (error) => { moduleLexerFailure = sanitizePreflightFailure(error); },
  );
}

attachModuleLexer(rawModuleLexerInit, rawParseModuleSyntax);

/** @internal deterministic init/parse failure seam. */
export function setMobilePluginLexerForTests(init: PromiseLike<unknown>, parser: ModuleParser = rawParseModuleSyntax): () => void {
  attachModuleLexer(init, parser);
  return () => attachModuleLexer(rawModuleLexerInit, rawParseModuleSyntax);
}

const MOBILE_MODULES: Readonly<Record<string, unknown>> = Object.freeze({
  obsidian: GeodeAPI,
  geode: GeodeAPI,
  "@codemirror/state": CodeMirrorState,
  "@codemirror/view": CodeMirrorView,
  "@codemirror/commands": CodeMirrorCommands,
  "@codemirror/language": CodeMirrorLanguage,
  "@codemirror/autocomplete": CodeMirrorAutocomplete,
  "@lezer/common": LezerCommon,
  "@lezer/highlight": LezerHighlight,
});

export function classifyMobilePlugin(manifest: PluginManifest, optedIn = false): MobilePluginAdmission {
  if (manifest.isDesktopOnly === true) {
    return { compatibility: "desktop-only", label: "Desktop only", reason: "Manifest declares isDesktopOnly: true", allowed: false };
  }
  if (manifest.isDesktopOnly === false) {
    return { compatibility: "mobile-compatible", label: "Mobile compatible", reason: "Manifest explicitly declares mobile support", allowed: true };
  }
  return {
    compatibility: "unknown",
    label: "Unknown",
    reason: optedIn ? "Explicitly allowed on this mobile vault" : "Manifest does not declare mobile compatibility",
    allowed: optedIn,
  };
}

export function resolveMobilePluginModule(pluginId: string, specifier: string): unknown {
  if (Object.hasOwn(MOBILE_MODULES, specifier)) return MOBILE_MODULES[specifier];
  const safeSpecifier = typeof specifier === "string" ? safeModuleName(specifier) : "invalid-module";
  throw new Error(`Mobile plugin "${pluginId}" cannot load unsupported module "${safeSpecifier}".`);
}

function safeModuleName(value: string): string {
  return value.length <= 120 ? value.replace(/[^a-zA-Z0-9@/_.:-]/g, "?") : "invalid-module";
}

/** Validate all module records before Function compilation or plugin evaluation. */
export async function validateMobilePluginModule(code: string, pluginId: string): Promise<void> {
  if (new TextEncoder().encode(code).byteLength > MAX_MOBILE_PLUGIN_SOURCE_BYTES) {
    throw new MobilePluginModuleError("MOBILE_PLUGIN_SOURCE_TOO_LARGE", pluginId, "entrypoint exceeds the 16 MiB mobile limit.");
  }
  await moduleLexerReady;
  if (moduleLexerFailure) {
    throw new MobilePluginModuleError("MOBILE_PLUGIN_PREFLIGHT_FAILED", pluginId, `preflight initialization failed: ${moduleLexerFailure}`);
  }
  let imports: ReturnType<typeof parseModuleSyntax>[0];
  let exports: ReturnType<typeof parseModuleSyntax>[1];
  try {
    [imports, exports] = parseModuleSyntax(code, `${pluginId}/main.js`);
  } catch {
    throw new MobilePluginModuleError("MOBILE_PLUGIN_MODULE_SYNTAX_INVALID", pluginId, "contains invalid module syntax.");
  }
  const first = imports[0];
  if (first) {
    if (first.t === ImportType.ImportMeta) {
      throw new MobilePluginModuleError("MOBILE_PLUGIN_IMPORT_META", pluginId, "cannot use import.meta.");
    }
    if (first.t === ImportType.Dynamic || first.t === ImportType.DynamicSourcePhase || first.t === ImportType.DynamicDeferPhase) {
      if (first.n === undefined) {
        throw new MobilePluginModuleError("MOBILE_PLUGIN_DYNAMIC_IMPORT_EXPRESSION", pluginId, "cannot use a computed dynamic import.");
      }
      throw new MobilePluginModuleError("MOBILE_PLUGIN_DYNAMIC_IMPORT", pluginId, `cannot import "${safeModuleName(first.n)}" dynamically.`);
    }
    throw new MobilePluginModuleError("MOBILE_PLUGIN_STATIC_IMPORT", pluginId, `cannot import "${safeModuleName(first.n ?? "invalid-module")}" statically.`);
  }
  if (exports.length) {
    throw new MobilePluginModuleError("MOBILE_PLUGIN_ESM_EXPORT", pluginId, "must use CommonJS exports, not ESM export syntax.");
  }
}

/** Parse and compile without evaluating module top-level code. */
export async function compileMobilePluginModule(code: string, pluginId: string): Promise<() => PluginConstructor> {
  await validateMobilePluginModule(code, pluginId);
  const moduleObj: { exports: unknown } = { exports: {} };
  const requireShim = (specifier: string) => resolveMobilePluginModule(pluginId, specifier);
  // Plugin bundles are installed code, evaluated only after mobile admission.
  // eslint-disable-next-line no-new-func
  const run = new Function("module", "exports", "require", `"use strict";\n${code}`);
  return () => {
    run(moduleObj, moduleObj.exports, requireShim);
    const candidate = (moduleObj.exports as { default?: unknown })?.default ?? moduleObj.exports;
    if (typeof candidate !== "function") {
      throw new Error(`Mobile plugin "${pluginId}" main module must export a Plugin class.`);
    }
    return candidate as PluginConstructor;
  };
}

export async function instantiateMobilePluginClass(code: string, pluginId: string): Promise<PluginConstructor> {
  return (await compileMobilePluginModule(code, pluginId))();
}
