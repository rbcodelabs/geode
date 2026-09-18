import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderSupportedPluginCatalog,
  supportedCatalogStateLabel,
  type SupportedCatalogViewDeps,
} from "../../src/renderer/community/supported-catalog-view";
import type {
  SupportedPlugin,
  SupportedPluginCatalogIpcState,
} from "../../src/main/supported-plugin-catalog";
import type { InstalledResult } from "../../src/main/github-resolve";

describe("supported catalog presentation", () => {
  it("describes stale data neutrally without claiming the device is offline", () => {
    const label = supportedCatalogStateLabel("stale", "2026-09-09T12:00:00.000Z");
    expect(label).toContain("using cached catalog");
    expect(label).not.toContain("offline");
  });

  it("wraps catalog rows and controls in narrow Settings layouts", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../styles/app.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*\.supported-plugin-item[\s\S]*flex-direction:\s*column/);
    expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*\.supported-plugin-controls[\s\S]*align-items:\s*stretch/);
  });
});

/** Minimal stand-in for the DOM nodes the catalog view touches. */
class FakeElement {
  className = "";
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  type = "";
  value = "";
  innerHTML = "";
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  listeners = new Map<string, () => Promise<void> | void>();
  classList = {
    add: (name: string) => { this.classNames.add(name); },
    remove: (name: string) => { this.classNames.delete(name); },
    toggle: (name: string, on: boolean) => { if (on) this.classNames.add(name); else this.classNames.delete(name); },
    contains: (name: string) => this.classNames.has(name),
  };
  classNames = new Set<string>();
  append(...children: FakeElement[]) { this.children.push(...children); }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  setAttribute(name: string, value: string) { (this as Record<string, unknown>)[name] = value; }
  addEventListener(event: string, listener: () => Promise<void> | void) {
    this.listeners.set(event, listener);
  }
  async click() { await this.listeners.get("click")?.(); }
}

function nodes(node: FakeElement): FakeElement[] {
  return [node, ...node.children.flatMap(nodes)];
}
function find(root: FakeElement, className: string): FakeElement | undefined {
  return nodes(root).find((n) => n.className.split(" ").includes(className));
}

const PLUGIN: SupportedPlugin = {
  id: "terminal",
  name: "Terminal",
  description: "Integrated terminal.",
  github: { owner: "polyipseity", repo: "obsidian-terminal" },
  manifest: { version: "3.27.2", releaseTag: "3.27.2", minAppVersion: "0.1.0" },
  platforms: ["desktop"],
  minimumGeodeVersion: "0.1.0",
  certifiedWithGeodeVersion: "0.21.0",
  artifactHashes: { "manifest.json": "a", "main.js": "b" },
  evidenceUrl: "https://example.invalid/evidence",
  status: "active",
};

const INSTALLED: InstalledResult = {
  repo: "polyipseity/obsidian-terminal",
  type: "plugin",
  id: "terminal",
  name: "Terminal",
  version: "3.27.2",
  minAppVersion: "0.1.0",
  source: "release",
  ref: "3.27.2",
};

const CATALOG_STATE: SupportedPluginCatalogIpcState = {
  status: "fresh",
  fetchedAt: "2026-09-17T12:00:00.000Z",
  currentGeodeVersion: "0.21.0",
  catalog: { schemaVersion: 1, plugins: [PLUGIN] },
};

function makeDeps(over: Partial<SupportedCatalogViewDeps> = {}): SupportedCatalogViewDeps {
  return {
    load: async () => CATALOG_STATE,
    install: async () => INSTALLED,
    enable: vi.fn(async () => {}),
    getLoadError: () => undefined,
    onInstalled: vi.fn(),
    ...over,
  };
}

async function renderRow(deps: SupportedCatalogViewDeps): Promise<FakeElement> {
  const container = new FakeElement();
  await renderSupportedPluginCatalog(container as unknown as HTMLElement, deps);
  return nodes(container).find((n) => n.className === "supported-plugin-item")!;
}

describe("supported catalog enable-after-install", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubDom() {
    vi.stubGlobal("document", {
      createElement: () => new FakeElement(),
      createTextNode: (textContent: string) => Object.assign(new FakeElement(), { textContent }),
    });
  }

  it("offers an enable-after-install checkbox that is OFF by default", async () => {
    stubDom();
    const row = await renderRow(makeDeps());
    const checkbox = find(row, "supported-plugin-enable-checkbox")!;
    expect(checkbox).toBeDefined();
    expect(checkbox.type).toBe("checkbox");
    expect(checkbox.checked).toBe(false);
  });

  it("installs WITHOUT enabling when the checkbox is left alone", async () => {
    stubDom();
    const enable = vi.fn(async () => {});
    const install = vi.fn(async () => INSTALLED);
    const row = await renderRow(makeDeps({ enable, install }));

    await find(row, "supported-plugin-install")!.click();

    expect(install).toHaveBeenCalledTimes(1);
    expect(enable).not.toHaveBeenCalled();
    expect(find(row, "supported-plugin-status")!.textContent).toBe("Installed Terminal 3.27.2");
  });

  it("enables only after the user opts in", async () => {
    stubDom();
    const enable = vi.fn(async () => {});
    const onInstalled = vi.fn();
    const row = await renderRow(makeDeps({ enable, onInstalled }));

    find(row, "supported-plugin-enable-checkbox")!.checked = true;
    await find(row, "supported-plugin-install")!.click();

    expect(enable).toHaveBeenCalledWith("terminal");
    expect(find(row, "supported-plugin-status")!.textContent).toBe("Enabled Terminal 3.27.2");
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it("flags a plugin that is enabled but has not finished starting up", async () => {
    stubDom();
    const row = await renderRow(makeDeps({ getLoadError: () => "onload() timed out" }));

    find(row, "supported-plugin-enable-checkbox")!.checked = true;
    await find(row, "supported-plugin-install")!.click();

    const status = find(row, "supported-plugin-status")!;
    expect(status.textContent).toContain("Installed and enabled Terminal 3.27.2");
    expect(status.textContent).toContain("onload() timed out");
  });

  it("reports an enable failure as an enable failure, not an install failure", async () => {
    stubDom();
    const onInstalled = vi.fn();
    const row = await renderRow(
      makeDeps({
        enable: async () => { throw new Error('Plugin "terminal" is blocked by administrator policy'); },
        onInstalled,
      }),
    );

    find(row, "supported-plugin-enable-checkbox")!.checked = true;
    await find(row, "supported-plugin-install")!.click();

    const status = find(row, "supported-plugin-status")!;
    expect(status.textContent).toContain("Installed Terminal 3.27.2");
    expect(status.textContent).toContain("but enabling failed");
    expect(status.textContent).toContain("blocked by administrator policy");
    expect(status.classList.contains("is-error")).toBe(true);
    // The install really did happen, so the installed list must still refresh.
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it("never enables when the install itself failed", async () => {
    stubDom();
    const enable = vi.fn(async () => {});
    const onInstalled = vi.fn();
    const row = await renderRow(
      makeDeps({
        install: async () => { throw new Error("checksum mismatch"); },
        enable,
        onInstalled,
      }),
    );

    find(row, "supported-plugin-enable-checkbox")!.checked = true;
    await find(row, "supported-plugin-install")!.click();

    expect(enable).not.toHaveBeenCalled();
    expect(onInstalled).not.toHaveBeenCalled();
    const status = find(row, "supported-plugin-status")!;
    expect(status.textContent).toBe("checksum mismatch");
    expect(status.classList.contains("is-error")).toBe(true);
  });

  it("disables the opt-in for a plugin that is incompatible with this Geode build", async () => {
    stubDom();
    const row = await renderRow(
      makeDeps({
        load: async () => ({ ...CATALOG_STATE, currentGeodeVersion: "0.0.1" }),
      }),
    );
    expect(find(row, "supported-plugin-enable-checkbox")!.disabled).toBe(true);
    expect(find(row, "supported-plugin-install")!.disabled).toBe(true);
  });
});
