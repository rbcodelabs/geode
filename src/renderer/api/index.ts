/**
 * Public "geode" module surface — the stable API a plugin author imports
 * from, analogous to `import { ... } from 'obsidian'`. Plugin `main.js`
 * gets this via `require('geode')` (see `../plugin-manager.ts`'s CJS
 * loader shim).
 *
 * This is a v1 subset scoped to Compass roadmap item 5 (see
 * `docs/spec/03-plugin-api.md` for the full documented-Obsidian-API
 * target and the plugin-api-layer PR report for exactly what's deferred).
 * It is a plain module within the app for now, not a published/versioned
 * npm package — splitting it out is noted as follow-up.
 *
 * Deliberately NOT re-exported here (out of scope for this PR — see report):
 * Modal / SuggestModal / FuzzySuggestModal, Setting / PluginSettingTab,
 * Menu, Notice as a class (use `app.notify()`), CM6 editor-extension
 * registration, `registerMarkdownPostProcessor`, `obsidian://` protocol
 * handling.
 */

// --- Runtime values ---------------------------------------------------------

export { Plugin } from "../plugin";
export { Component } from "../component";
export { Events } from "../events";
export { CommandRegistry } from "../commands";
export { Vault } from "../vault";
export { Workspace, WorkspaceLeaf, TabGroup, Sidebar } from "../workspace";
export { MetadataCache, parseMetadata } from "../metadata-cache";
export { MarkdownView } from "../views/markdown-view";
export { isTFile, isTFolder, pathParent, pathName } from "../types";
export {
  parseManifest,
  isVersionAtLeast,
  compareVersions,
  ManifestError,
  GEODE_API_VERSION,
} from "../plugin-manifest";

// --- Types only (erased at build time — no runtime dependency on ../app) ---

export type { App } from "../app";
export type { View } from "../workspace";
export type { Command } from "../commands";
export type { EventRef, EventCallback } from "../events";
export type { PluginManifest } from "../plugin-manifest";
export type { PluginCommand } from "../plugin";
export type {
  TAbstractFile,
  TFile,
  TFolder,
  CachedMetadata,
  LinkCache,
  TagCache,
  HeadingCache,
  Pos,
  Loc,
} from "../types";
