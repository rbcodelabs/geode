// Must be imported BEFORE anything that pulls in `app.ts`: the obsidian shim starts the app at import time.
import { createBrowserHost, createBrowserHostState } from "../../../src/renderer/host/browser-host";
import { installHostServices } from "../../../src/renderer/host/registry";
import { createLegacyGeodeFacade } from "../../../src/renderer/host/legacy-facade";

export interface HarnessSeed {
  vaultName?: string;
  files?: Record<string, string>;
  /** Plugin ids to enable on boot (files must already be seeded under .geode/plugins/<id>/). */
  enabledPlugins?: string[];
  /** The browser host is a mobile runtime; this keeps `is-mobile` on <body>. Default true. */
  mobile?: boolean;
}

const seed: HarnessSeed = (window as any).__geodeSeed ?? {};
const state = createBrowserHostState({
  vaultName: seed.vaultName ?? "Test Vault",
  files: { "Welcome.md": "# Hello\n", ...(seed.files ?? {}) },
});
if (seed.enabledPlugins) state.config.set("plugins", seed.enabledPlugins);
const host = installHostServices(createBrowserHost(state));
(window as any).geode = createLegacyGeodeFacade(host);
if (seed.mobile ?? true) document.body.classList.add("is-mobile");
// Bundled plugins commonly read these at load.
(globalThis as any).__dirname ??= "/";
(globalThis as any).__filename ??= "/plugin/main.js";
