import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/app";
import { instantiatePluginClass } from "../../src/renderer/plugin-manager";
import { MarkdownView } from "../../src/renderer/views/markdown-view";
import { DEFAULT_METADATA_SCAN_CAP_BYTES } from "../../src/indexer/metadata-indexer";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

function installBrowser(theme: "dark" | "light" = "dark"): MemoryStorage {
  const storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", {
    body: { classList: { contains: (name: string) => name === `theme-${theme}` } },
    querySelectorAll: vi.fn(() => []),
  });
  return storage;
}

afterEach(() => vi.unstubAllGlobals());

describe("App public foundation", () => {
  it("exposes the vault and metadata cache identities", () => {
    installBrowser();
    const app = new App();
    const workspace = {} as any;
    app.workspace = workspace;

    expect(app.vault).toBeDefined();
    expect(app.workspace).toBe(workspace);
    expect(app.metadataCache).toBeDefined();
    expect(app.metadataCache.getFileCache).toBeTypeOf("function");
  });

  it("defaults settings.metadataScanCapBytes to the shipped default before any vault settings are loaded", () => {
    installBrowser();
    const app = new App();
    expect(app.settings.metadataScanCapBytes).toBe(DEFAULT_METADATA_SCAN_CAP_BYTES);
    // Wired to MetadataCache via setScanCapBytes (see openVaultMeasured) —
    // confirm the method exists and is callable without a vault open yet.
    expect(app.metadataCache.setScanCapBytes).toBeTypeOf("function");
    expect(() => app.metadataCache.setScanCapBytes(app.settings.metadataScanCapBytes)).not.toThrow();
  });

  it("reports the active body color scheme", () => {
    installBrowser("dark");
    expect(new App().isDarkMode()).toBe(true);
    installBrowser("light");
    expect(new App().isDarkMode()).toBe(false);
  });

  it("round-trips serializable vault-scoped values and isolates vaults", () => {
    installBrowser();
    const first = new App();
    first.vault.root = "/vault/one";
    const second = new App();
    second.vault.root = "/vault/two";

    expect(first.loadLocalStorage("state")).toBeNull();
    first.saveLocalStorage("state", { count: 2, nested: [true, "x"] });
    second.saveLocalStorage("state", "other");
    expect(first.loadLocalStorage("state")).toEqual({ count: 2, nested: [true, "x"] });
    expect(second.loadLocalStorage("state")).toBe("other");
  });

  it("deletes an entry when null is saved without affecting another vault or key", () => {
    installBrowser();
    const first = new App();
    first.vault.root = "/vault/one";
    const second = new App();
    second.vault.root = "/vault/two";
    first.saveLocalStorage("remove", 1);
    first.saveLocalStorage("keep", false);
    second.saveLocalStorage("remove", 2);

    first.saveLocalStorage("remove", null);
    expect(first.loadLocalStorage("remove")).toBeNull();
    expect(first.loadLocalStorage("keep")).toBe(false);
    expect(second.loadLocalStorage("remove")).toBe(2);
  });

  it("mounts the exact element created by Plugin.addStatusBarItem() into the status bar", () => {
    installBrowser();
    const app = new App();
    const appended: unknown[] = [];
    (app as any).statusBar = { containerEl: { appendChild: (el: unknown) => appended.push(el) } };
    const el = { nodeName: "DIV" } as unknown as HTMLElement;
    app.addStatusBarItem(el);
    expect(appended).toEqual([el]);
  });

  it("does not use a stale active Markdown leaf when a guest hotkey source cannot be resolved", () => {
    installBrowser();
    const app = new App();
    const editor = { state: { doc: "stale" } };
    const view = Object.assign(Object.create(MarkdownView.prototype), { mode: "live", editor });
    app.workspace = { activeLeaf: { view } } as any;
    const callback = vi.fn();
    app.commands.add({ id: "guest-unresolved", name: "Guest unresolved", editorCallback: callback } as any);

    (app as any).guestHotkeySource = 999_999;

    expect(app.commands.execute("guest-unresolved")).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("App through require('obsidian')", () => {
  it("exports the runtime class and vault-scoped storage methods to CommonJS plugins", () => {
    installBrowser();
    const PluginClass = instantiatePluginClass(
      `
        const { App } = require("obsidian");
        module.exports = class AppProbe {
          static results = (() => {
            const app = new App();
            app.vault.root = "/plugin-vault";
            app.saveLocalStorage("probe", { ok: true });
            return [app instanceof App, app.loadLocalStorage("probe"), app.isDarkMode()];
          })();
        };
      `,
      "app-probe",
    ) as unknown as { results: unknown[] };

    expect(PluginClass.results).toEqual([true, { ok: true }, true]);
  });
});
