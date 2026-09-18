import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendLoadErrorDiagnostic,
  createPluginEnableControl,
  createTrackedItemEnableControl,
  renderInstalledPluginRow,
  selectUntrackedManifests,
  type CommunityListViewDeps,
} from "../../src/renderer/community/community-list-view";
import type { PluginManifest } from "../../src/renderer/plugin-manifest";
import type { CommunityItem } from "../../src/renderer/community/store";

/** Minimal stand-in for the DOM nodes these builders touch (house pattern). */
class FakeElement {
  className = "";
  textContent = "";
  /** Present so a test can prove the builders never reach for it. */
  innerHTML = "";
  title = "";
  disabled = false;
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  listeners = new Map<string, () => Promise<void> | void>();
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
function text(node: FakeElement): string {
  return nodes(node).map((n) => n.textContent).join(" ");
}
function stubDom() {
  vi.stubGlobal("document", { createElement: () => new FakeElement() });
}

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "terminal",
    name: "Terminal",
    version: "3.27.2",
    minAppVersion: "0.1.0",
    description: "",
    author: "polyipseity",
    ...over,
  } as PluginManifest;
}

function makeDeps(over: Partial<CommunityListViewDeps> = {}): CommunityListViewDeps {
  return {
    isMobileRuntime: () => false,
    isBlocked: () => false,
    isEnabled: () => false,
    getManifest: () => manifest(),
    getLoadError: () => undefined,
    quarantinedIds: () => new Set<string>(),
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    notify: vi.fn(),
    refresh: vi.fn(),
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("plugin enable control", () => {
  it("offers Enable for an installed-but-disabled plugin and runs enable() on click", async () => {
    stubDom();
    const enable = vi.fn(async () => {});
    const refresh = vi.fn();
    const deps = makeDeps({ enable, refresh });

    const toggle = createPluginEnableControl("terminal", deps)!;
    expect(toggle).not.toBeNull();
    expect(toggle.textContent).toBe("Enable");
    expect(toggle.disabled).toBe(false);

    await toggle.click();
    expect(enable).toHaveBeenCalledWith("terminal");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("offers Disable for an enabled plugin and runs disable() on click", async () => {
    stubDom();
    const disable = vi.fn(async () => {});
    const enable = vi.fn(async () => {});
    const toggle = createPluginEnableControl(
      "terminal",
      makeDeps({ isEnabled: () => true, enable, disable }),
    )!;

    expect(toggle.textContent).toBe("Disable");
    await toggle.click();
    expect(disable).toHaveBeenCalledWith("terminal");
    expect(enable).not.toHaveBeenCalled();
  });

  it("surfaces an enable failure through notify instead of throwing", async () => {
    stubDom();
    const notify = vi.fn();
    const refresh = vi.fn();
    const toggle = createPluginEnableControl(
      "terminal",
      makeDeps({
        enable: async () => { throw new Error("onload() exploded"); },
        notify,
        refresh,
      }),
    )!;

    await expect(toggle.click()).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith("onload() exploded");
    // The list still re-renders, so the row reflects the failed state.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // --- negative cases -------------------------------------------------------

  it("gives a policy-blocked plugin no usable enable control", async () => {
    stubDom();
    const enable = vi.fn(async () => {});
    const toggle = createPluginEnableControl(
      "terminal",
      makeDeps({ isBlocked: () => true, enable }),
    )!;

    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe("Disabled by administrator policy");
    // Even if something dispatched a click, nothing is wired to enable it.
    await toggle.click();
    expect(enable).not.toHaveBeenCalled();
  });

  it("still lets a blocked plugin be disabled if policy arrived after it loaded", async () => {
    stubDom();
    const disable = vi.fn(async () => {});
    const toggle = createPluginEnableControl(
      "terminal",
      makeDeps({ isBlocked: () => true, isEnabled: () => true, disable }),
    )!;

    expect(toggle.disabled).toBe(false);
    expect(toggle.textContent).toBe("Disable");
    await toggle.click();
    expect(disable).toHaveBeenCalledWith("terminal");
  });

  it("yields no control for a quarantined plugin — the quarantine row owns it", () => {
    stubDom();
    expect(
      createPluginEnableControl("terminal", makeDeps({ quarantinedIds: () => new Set(["terminal"]) })),
    ).toBeNull();
  });

  it("yields no control on the mobile runtime — renderMobilePluginRow owns it", () => {
    stubDom();
    expect(createPluginEnableControl("terminal", makeDeps({ isMobileRuntime: () => true }))).toBeNull();
  });

  it("yields no control when the plugin is tracked but absent from disk", () => {
    stubDom();
    expect(createPluginEnableControl("terminal", makeDeps({ getManifest: () => undefined }))).toBeNull();
  });
});

describe("untracked installed plugins", () => {
  const tracked: CommunityItem[] = [
    { repo: "o/tracked", type: "plugin", id: "tracked", installedVersion: "1.0.0", source: "release", ref: "1.0.0", autoUpdate: false },
    // A theme whose id happens to collide with a plugin id must not mask the plugin.
    { repo: "o/themey", type: "theme", id: "imported", installedVersion: "1.0.0", source: "release", ref: "1.0.0", autoUpdate: false },
  ];

  it("selects plugins on disk that community.json never recorded", () => {
    const selected = selectUntrackedManifests(
      [manifest({ id: "tracked" }), manifest({ id: "imported" }), manifest({ id: "bootstrapped" })],
      tracked,
      new Set(),
    );
    // "imported" is only tracked as a *theme*, so the plugin is still untracked.
    expect(selected.map((m) => m.id)).toEqual(["imported", "bootstrapped"]);
  });

  it("excludes quarantined plugins so they are not rendered twice", () => {
    const selected = selectUntrackedManifests(
      [manifest({ id: "bootstrapped" }), manifest({ id: "broken" })],
      [],
      new Set(["broken"]),
    );
    expect(selected.map((m) => m.id)).toEqual(["bootstrapped"]);
  });

  it("renders an untracked row carrying the enable control and no update tracking", () => {
    stubDom();
    const row = renderInstalledPluginRow(manifest({ id: "imported", name: "Imported Plugin" }), makeDeps());

    expect(row.dataset.pluginId).toBe("imported");
    expect(row.className).toContain("installed-plugin-item");
    const body = text(row);
    expect(body).toContain("Imported Plugin");
    expect(body).toContain("not tracked for updates");
    expect(nodes(row).filter((n) => n.className === "community-item-enable")).toHaveLength(1);
  });

  it("marks a blocked untracked plugin and leaves its control inert", () => {
    stubDom();
    const row = renderInstalledPluginRow(manifest(), makeDeps({ isBlocked: () => true }));

    expect(text(row)).toContain("blocked by admin");
    const toggle = nodes(row).find((n) => n.className === "community-item-enable")!;
    expect(toggle.disabled).toBe(true);
  });

  it("does not route author-controlled manifest names through innerHTML", () => {
    stubDom();
    const row = renderInstalledPluginRow(manifest({ name: "<img src=x onerror=alert(1)>" }), makeDeps());
    const title = nodes(row).find((n) => n.className === "community-item-title")!;
    // Set as text, never as markup.
    expect(title.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(nodes(row).every((n) => n.innerHTML === "")).toBe(true);
  });
});

describe("tracked community rows", () => {
  function item(over: Partial<CommunityItem> = {}): CommunityItem {
    return {
      repo: "polyipseity/obsidian-terminal",
      type: "plugin",
      id: "terminal",
      installedVersion: "3.27.2",
      source: "release",
      ref: "3.27.2",
      autoUpdate: false,
      ...over,
    } as CommunityItem;
  }

  it("gives a tracked plugin an enable control", () => {
    stubDom();
    const toggle = createTrackedItemEnableControl(item(), makeDeps());
    expect(toggle?.textContent).toBe("Enable");
  });

  it("gives a theme no enable control — themes are applied, not enabled", () => {
    stubDom();
    // getManifest is deliberately still answering: the exclusion must come from
    // the item type, not from the theme happening to be absent from disk.
    expect(createTrackedItemEnableControl(item({ type: "theme", id: "some-theme" }), makeDeps()))
      .toBeNull();
  });

  it("gives a blocked tracked plugin no usable enable control", () => {
    stubDom();
    const toggle = createTrackedItemEnableControl(item(), makeDeps({ isBlocked: () => true }))!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe("Disabled by administrator policy");
  });
});

describe("load-error diagnostic", () => {
  it("appends the last load failure with an alert role", () => {
    stubDom();
    const info = new FakeElement();
    appendLoadErrorDiagnostic(
      info as unknown as HTMLElement,
      "terminal",
      makeDeps({ getLoadError: () => "Cannot find module 'node:pty'" }),
    );
    const diagnostic = info.children[0];
    expect(diagnostic.textContent).toBe("Cannot find module 'node:pty'");
    expect(diagnostic.className).toBe("community-plugin-diagnostic");
    expect((diagnostic as unknown as { role: string }).role).toBe("alert");
  });

  it("appends nothing on a clean start", () => {
    stubDom();
    const info = new FakeElement();
    appendLoadErrorDiagnostic(info as unknown as HTMLElement, "terminal", makeDeps());
    expect(info.children).toHaveLength(0);
  });
});
