import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

const MANIFEST = {
  id: "view-workspaceleaf-contract-probe",
  name: "View and WorkspaceLeaf Contract Probe",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Exercises existing View and WorkspaceLeaf compatibility contracts.",
  author: "geode",
};

/**
 * A real CommonJS plugin fixture. Keeping the assertions behind
 * `require('obsidian')` proves the public plugin module and the Electron host
 * together, rather than importing Geode's implementation into the test.
 */
const MAIN_JS = `
  const obsidian = require('obsidian');
  const VIEW_TYPE = 'view-workspaceleaf-contract-probe';
  const REPLACEMENT_TYPE = 'view-workspaceleaf-contract-replacement';

  const probe = window.__viewWorkspaceLeafContractProbe = {
    lifecycle: [],
    stateCalls: [],
  };

  class ProbeView extends obsidian.View {
    constructor(leaf) {
      super(leaf);
      this.icon = 'panel-top';
      this.savedState = { revision: 0 };
      probe.constructedView = this;
      probe.construction = {
        isView: this instanceof obsidian.View,
        leafIdentity: this.leaf === leaf,
        appIdentity: this.app === leaf.app,
        containerIsElement: this.containerEl instanceof HTMLElement,
        containerClass: this.containerEl.className,
        icon: this.icon,
        navigation: this.navigation,
        scope: this.scope,
      };
    }

    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return 'View Contract Probe'; }
    getState() { return { ...this.savedState }; }
    async setState(state, result) {
      this.savedState = { ...state };
      probe.stateCalls.push({ state: this.getState(), result, sameView: this === probe.constructedView });
    }
    async onOpen() {
      probe.lifecycle.push('open');
      this.containerEl.createDiv({ cls: 'view-contract-probe-body', text: 'view-opened' });
    }
    async onClose() { probe.lifecycle.push('close'); }
  }

  class ReplacementView extends obsidian.View {
    getViewType() { return REPLACEMENT_TYPE; }
    getDisplayText() { return 'Replacement Probe'; }
    async onOpen() {
      probe.lifecycle.push('replacement-open');
      this.containerEl.createDiv({ cls: 'replacement-probe-body', text: 'replacement-opened' });
    }
  }

  probe.ProbeView = ProbeView;

  module.exports.default = class extends obsidian.Plugin {
    async onload() {
      this.registerView(VIEW_TYPE, (leaf) => new ProbeView(leaf));
      this.registerView(REPLACEMENT_TYPE, (leaf) => new ReplacementView(leaf));
      probe.loaded = true;
    }
  };
`;

function makeVault(): { vaultDir: string; userDataDir: string } {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-view-contract-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-view-contract-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# View contract\n");
  const pluginDir = path.join(vaultDir, ".geode", "plugins", MANIFEST.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(pluginDir, "main.js"), MAIN_JS);
  fs.writeFileSync(path.join(vaultDir, ".geode", "plugins.json"), JSON.stringify([MANIFEST.id]));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({
    recentVaults: [vaultDir],
    lastVault: vaultDir,
  }));
  return { vaultDir, userDataDir };
}

test("a CommonJS plugin observes View and WorkspaceLeaf lifecycle, state, display, icon, and pinning contracts", async () => {
  const { vaultDir, userDataDir } = makeVault();
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });
  const consoleErrors: string[] = [];

  try {
    const window = await app.firstWindow();
    window.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    window.on("pageerror", (error) => consoleErrors.push(String(error)));
    await window.waitForFunction(() =>
      (window as any).app?.workspace?.layoutReady === true
      && (window as any).__viewWorkspaceLeafContractProbe?.loaded === true
    );

    const observed = await window.evaluate(async () => {
      const workspace = (window as any).app.workspace;
      const probe = (window as any).__viewWorkspaceLeafContractProbe;
      const leaf = workspace.getLeaf(true);
      const view = new probe.ProbeView(leaf);
      const initial = {
        viewType: view.getViewType(),
        displayText: view.getDisplayText(),
        icon: view.getIcon(),
        state: view.getState(),
        ephemeral: view.getEphemeralState(),
      };

      const ephemeralInput = { cursor: 3, mode: "preview" };
      view.setEphemeralState(ephemeralInput);
      ephemeralInput.cursor = 99;
      const opened = await leaf.open(view);
      const afterOpen = {
        returnedSameView: opened === view,
        leafViewIdentity: leaf.view === view,
        leafDisplayText: leaf.getDisplayText(),
        ephemeral: view.getEphemeralState(),
        lifecycle: [...probe.lifecycle],
        containerConnected: view.containerEl.isConnected,
        bodyText: view.containerEl.querySelector(".view-contract-probe-body")?.textContent,
      };

      await leaf.setViewState({
        type: "view-workspaceleaf-contract-probe",
        active: true,
        state: { revision: 1, label: "saved" },
      });
      const afterSetViewState = {
        sameView: leaf.view === view,
        viewState: leaf.getViewState(),
        stateCalls: [...probe.stateCalls],
        lifecycle: [...probe.lifecycle],
      };

      leaf.setPinned(true);
      const afterSetPinned = { pinned: leaf.pinned, sameView: leaf.view === view };
      leaf.togglePinned();
      const afterToggleOff = { pinned: leaf.pinned, sameView: leaf.view === view };
      leaf.togglePinned();
      const afterToggleOn = { pinned: leaf.pinned, sameView: leaf.view === view };

      const beforeReplacement = {
        tabClass: leaf.tabEl.className,
        tabLabel: leaf.tabEl.getAttribute("aria-label"),
        tabTitle: leaf.tabEl.querySelector(".workspace-tab-header-inner-title")?.textContent,
        hasIconSvg: !!leaf.tabEl.querySelector(".workspace-tab-header-inner-icon svg"),
      };
      await leaf.setViewState({ type: "view-workspaceleaf-contract-replacement", active: true });

      return {
        construction: probe.construction,
        initial,
        afterOpen,
        afterSetViewState,
        afterSetPinned,
        afterToggleOff,
        afterToggleOn,
        beforeReplacement,
        lifecycleAfterReplacement: [...probe.lifecycle],
      };
    });

    expect(observed.construction).toEqual({
      isView: true,
      leafIdentity: true,
      appIdentity: true,
      containerIsElement: true,
      containerClass: "workspace-leaf-content view-content-host",
      icon: "panel-top",
      navigation: false,
      scope: null,
    });
    expect(observed.initial).toEqual({
      viewType: "view-workspaceleaf-contract-probe",
      displayText: "View Contract Probe",
      icon: "panel-top",
      state: { revision: 0 },
      ephemeral: {},
    });
    expect(observed.afterOpen).toEqual({
      returnedSameView: true,
      leafViewIdentity: true,
      leafDisplayText: "View Contract Probe",
      ephemeral: { cursor: 3, mode: "preview" },
      lifecycle: ["open"],
      containerConnected: true,
      bodyText: "view-opened",
    });
    expect(observed.afterSetViewState).toEqual({
      sameView: true,
      viewState: {
        type: "view-workspaceleaf-contract-probe",
        state: { revision: 1, label: "saved" },
      },
      stateCalls: [{
        state: { revision: 1, label: "saved" },
        result: {},
        sameView: true,
      }],
      lifecycle: ["open"],
    });
    expect(observed.afterSetPinned).toEqual({ pinned: true, sameView: true });
    expect(observed.afterToggleOff).toEqual({ pinned: false, sameView: true });
    expect(observed.afterToggleOn).toEqual({ pinned: true, sameView: true });
    expect(observed.beforeReplacement.tabClass).toContain("mod-pinned");
    expect(observed.beforeReplacement.tabLabel).toBe("View Contract Probe");
    expect(observed.beforeReplacement.tabTitle).toBe("View Contract Probe");
    expect(observed.beforeReplacement.hasIconSvg).toBe(true);
    expect(observed.lifecycleAfterReplacement).toEqual(["open", "close", "replacement-open"]);

    const activeTab = window.locator(".workspace-split.mod-root .workspace-tab-header.is-active");
    await expect(activeTab).toHaveAttribute("aria-label", "Replacement Probe");
    await expect(window.locator(".replacement-probe-body")).toHaveText("replacement-opened");
    await expect(window.locator(".view-contract-probe-body")).toHaveCount(0);
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
