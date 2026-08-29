import { describe, expect, it, vi } from "vitest";
import { classifyMobilePlugin, compileMobilePluginModule, instantiateMobilePluginClass, MAX_MOBILE_PLUGIN_SOURCE_BYTES, resolveMobilePluginModule, setMobilePluginLexerForTests, validateMobilePluginModule } from "../../src/renderer/mobile-plugin-runtime";
import type { PluginManifest } from "../../src/renderer/plugin-manifest";

function manifest(isDesktopOnly?: boolean): PluginManifest {
  return { id: "probe", name: "Probe", version: "1.0.0", minAppVersion: "1.0.0", description: "probe", author: "test", ...(isDesktopOnly === undefined ? {} : { isDesktopOnly }) };
}

describe("mobile plugin admission", () => {
  it("admits explicit mobile manifests and blocks desktop-only manifests", () => {
    expect(classifyMobilePlugin(manifest(false))).toMatchObject({ compatibility: "mobile-compatible", allowed: true });
    expect(classifyMobilePlugin(manifest(true))).toMatchObject({ compatibility: "desktop-only", allowed: false });
  });

  it("requires an explicit opt-in for an unknown manifest", () => {
    expect(classifyMobilePlugin(manifest())).toMatchObject({ compatibility: "unknown", allowed: false });
    expect(classifyMobilePlugin(manifest(), true)).toMatchObject({ compatibility: "unknown", allowed: true });
  });
});

describe("mobile CommonJS resolver", () => {
  it.each(["obsidian", "geode", "@codemirror/state", "@codemirror/view", "@codemirror/commands", "@codemirror/language", "@codemirror/autocomplete", "@lezer/common", "@lezer/highlight"])("resolves approved module %s", (specifier) => {
    expect(resolveMobilePluginModule("probe", specifier)).toBeTruthy();
  });

  it.each(["fs", "node:fs", "path", "electron", "child_process", "native.node", "unknown-package"])("rejects unsupported module %s with a stable path-free diagnostic", (specifier) => {
    expect(() => resolveMobilePluginModule("probe", specifier)).toThrow(`Mobile plugin "probe" cannot load unsupported module "${specifier}".`);
  });

  it("rejects a dynamic unsupported require when the plugin invokes it", async () => {
    const PluginClass = await instantiateMobilePluginClass("module.exports = class { run() { require('node:fs') } }", "dynamic-probe");
    expect(() => (PluginClass.prototype as { run(): void }).run()).toThrow('unsupported module "node:fs"');
  });

  it.each([
    ["import fs from 'node:fs'; module.exports = fs", "MOBILE_PLUGIN_STATIC_IMPORT", "node:fs"],
    ["if (ok) { import('electron') }", "MOBILE_PLUGIN_DYNAMIC_IMPORT", "electron"],
    ["function nested(name) { return import(name) }", "MOBILE_PLUGIN_DYNAMIC_IMPORT_EXPRESSION", "computed dynamic import"],
    ["module.exports = import.meta.url", "MOBILE_PLUGIN_IMPORT_META", "import.meta"],
    ["export default class Probe {}", "MOBILE_PLUGIN_ESM_EXPORT", "CommonJS"],
  ])("rejects module syntax before evaluation: %s", async (code, errorCode, diagnostic) => {
    (globalThis as any).__moduleTripwire = 0;
    await expect(validateMobilePluginModule(`globalThis.__moduleTripwire++; ${code}`, "module-probe"))
      .rejects.toMatchObject({ code: errorCode, message: expect.stringContaining(diagnostic) });
    expect((globalThis as any).__moduleTripwire).toBe(0);
    delete (globalThis as any).__moduleTripwire;
  });

  it("compiles without evaluating top-level code", async () => {
    (globalThis as any).__moduleTripwire = 0;
    const evaluate = await compileMobilePluginModule("globalThis.__moduleTripwire++; module.exports = class {}", "probe");
    expect((globalThis as any).__moduleTripwire).toBe(0);
    evaluate();
    expect((globalThis as any).__moduleTripwire).toBe(1);
    delete (globalThis as any).__moduleTripwire;
  });

  it("rejects an oversized entrypoint before lexer initialization or evaluation", async () => {
    await expect(validateMobilePluginModule(" ".repeat(MAX_MOBILE_PLUGIN_SOURCE_BYTES + 1), "large-probe"))
      .rejects.toMatchObject({ code: "MOBILE_PLUGIN_SOURCE_TOO_LARGE" });
  });

  it.each([
    ["export { value } from 'remote';", "MOBILE_PLUGIN_STATIC_IMPORT", "remote"],
    ["import source wasm from './probe.wasm';", "MOBILE_PLUGIN_STATIC_IMPORT", "./probe.wasm"],
    ["import defer * as feature from './feature.js';", "MOBILE_PLUGIN_STATIC_IMPORT", "./feature.js"],
    ["import('first'); import('second');", "MOBILE_PLUGIN_DYNAMIC_IMPORT", "first"],
    [String.raw`import('./\u000aescape')`, "MOBILE_PLUGIN_DYNAMIC_IMPORT", "?escape"],
  ])("rejects the first real module record in source order: %s", async (code, errorCode, detail) => {
    await expect(validateMobilePluginModule(code, "matrix-probe"))
      .rejects.toMatchObject({ code: errorCode, message: expect.stringContaining(detail) });
  });

  it("ignores import text in comments and strings", async () => {
    await expect(validateMobilePluginModule(`// import 'node:fs'\nconst text = "import('electron')"; module.exports = class {};`, "fake-import"))
      .resolves.toBeUndefined();
  });

  it("handles lexer init rejection synchronously without an unhandled rejection and keeps diagnostics path-free", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const restore = setMobilePluginLexerForTests(Promise.reject(new Error("/Users/private/lexer.wasm failed")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(validateMobilePluginModule("module.exports = class {}", "init-probe"))
      .rejects.toMatchObject({ code: "MOBILE_PLUGIN_PREFLIGHT_FAILED", message: expect.not.stringContaining("/Users/") });
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
    restore();
  });

  it("normalizes parser failure to a stable module-syntax error", async () => {
    const restore = setMobilePluginLexerForTests(Promise.resolve(), (() => { throw new Error("/private/parser details"); }) as never);
    await expect(validateMobilePluginModule("module.exports = class {}", "parse-probe"))
      .rejects.toMatchObject({ code: "MOBILE_PLUGIN_MODULE_SYNTAX_INVALID", message: expect.not.stringContaining("/private/") });
    restore();
  });
});
